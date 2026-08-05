# Generic PDF Parser — Framework Integration

How the `generic` PDF parser is wired into the framework. The HTTP contract with
the microservice is specified separately in
`18_PDF_Parser_Generic_Microservice_Spec.md`.

The `generic` parser reuses the existing conventions of the Mistral OCR parser
(base64 images inline, `![id](id)` markdown placeholders replaced with storage
paths), so it slots into the current pipeline with no changes downstream of
`parsePdfFileAsMardown`.

---

## 1. Configuration

Three environment variables select and reach the service:

```bash
PDF_PARSER_SERVICE="generic"
PDF_PARSER_SERVICE_API_KEY="sk-abc123..."
PDF_PARSER_SERVICE_URL="https://parser.example.com"
```

Add these to `.env.default` (commented, as examples):

```bash
#PDF_PARSER_SERVICE="generic"
#PDF_PARSER_SERVICE_API_KEY="sk-abc123..."
#PDF_PARSER_SERVICE_URL="https://parser.example.com"
```

Authentication uses the `X-API-Key` header — same scheme as the existing
Symbiosika parser.

### 1.1 Attribute extraction (opt-in)

Set `enablePdfParserExtraction: true` in the server config (`setGlobalServerConfig`)
to have every document parse automatically request the tenant's configured
catalog attributes as structured extraction targets:

```ts
setGlobalServerConfig({
  // ...
  enablePdfParserExtraction: true,
});
```

When on, `parseFile`/`parseDocument` load the tenant's
`knowledge` config `attributes` (see `knowledge-config.ts`), map each definition
to an `ExtractionTarget` (`attributeDefinitionsToExtractionTargets`), and pass
them as `PdfParserOptions.extract`. The values the service returns are written
back:

- **wiki import** (`importKnowledgeTextFromFile`): valid values (facet-checked)
  land on the new page's `attributes`; the raw result — with `found` /
  `confidence` / `page` — is kept under `meta.parserExtraction`.
- **RAG ingestion** (`extractKnowledgeFromExistingDbEntry`): found values are
  folded into the knowledge entry's `meta`.

An explicit `options.extract` at a call site always wins over this automatic
resolution. When the flag is off, no tenant-config read happens and behaviour is
unchanged.

Give each attribute a `description` (and optionally a `type`) in the tenant
config so the extractor gets a real instruction:

```ts
setKnowledgeTenantConfig(tenantId, {
  attributes: [
    { key: "hersteller", label: "Hersteller", description: "Name des Herstellers" },
    { key: "typ", values: ["Datenblatt", "Handbuch"] }, // -> type "enum"
  ],
});
```

---

## 2. Types — `src/lib/knowledge/parsing/pdf/types.ts`

```ts
export const PDF_PARSER = {
  // ...existing...
  GENERIC: "generic",
} as const;

/** One structured value to extract from a document. */
export type ExtractionTarget = {
  key: string;
  name: string;
  description: string;
  required?: boolean;
  type?: "string" | "number" | "date" | "boolean" | "enum";
  options?: string[];
};

/** One extracted value in the result. */
export type ExtractedValue = {
  value: string | number | boolean | null;
  found: boolean;
  confidence?: number;
  page?: number;
};

export type PdfParserOptions = {
  model?: string;
  extractImages?: boolean;
  /** Structured extraction targets passed through to the service. */
  extract?: ExtractionTarget[];
  /** Extra service: analyse images embedded in the document (§2.1.1). */
  parseImagesInDoc?: boolean;
  /** Extra service: OCR on scanned / image-only pages. */
  ocr?: boolean;
  /** Extra service: detect tables and render them as Markdown. */
  detectTables?: boolean;
};

export interface PdfParserResult {
  includesImages: boolean;
  model: string;
  pages?: PageContent[];
  /** Extracted key/value metadata, keyed by ExtractionTarget.key. */
  metadata?: Record<string, ExtractedValue>;
}
```

`PdfParserResult.metadata` is the new field carrying the service's extraction
results. It can be persisted as JSON on the document immediately; downstream
consumption (search, filtering, validation of required fields) can be added
later without changing the wire contract.

---

## 3. Parser — `src/lib/knowledge/parsing/pdf/generic.ts`

Uses the synchronous endpoint by default and falls back to the async job flow if
`PDF_PARSER_SERVICE_MODE=async` is set.

```ts
import log from "../../../log";
import { resolveImageReferences } from "./images";
import {
  PDF_PARSER,
  type ExtractedValue,
  type PdfParser,
} from "./types";

const API_KEY = process.env.PDF_PARSER_SERVICE_API_KEY;
const BASE_URL = process.env.PDF_PARSER_SERVICE_URL;
const MODE = process.env.PDF_PARSER_SERVICE_MODE ?? "sync"; // "sync" | "async"

type RawImage = { id: string; base64: string };
type RawPage = { page: number; text: string; images?: RawImage[] };
type RawResult = {
  model: string;
  pages: RawPage[];
  metadata?: Record<string, ExtractedValue>;
};

const authHeaders = () => ({ "X-API-Key": API_KEY as string });

const buildForm = (file: File, options?: Parameters<PdfParser>[2]) => {
  const form = new FormData();
  form.append("file", file, "document.pdf");
  form.append("extract_images", String(options?.extractImages ?? false));
  if (options?.extract?.length) {
    form.append("extract", JSON.stringify(options.extract));
  }
  return form;
};

/** Synchronous: one POST /v1/parse. */
const runSync = async (form: FormData): Promise<RawResult> => {
  const res = await fetch(`${BASE_URL}/v1/parse`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Parsing failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as RawResult;
};

/** Asynchronous: create job -> poll -> fetch result. */
const runAsync = async (form: FormData): Promise<RawResult> => {
  const createRes = await fetch(`${BASE_URL}/v1/jobs`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!createRes.ok) {
    throw new Error(`Job creation failed: ${createRes.status} ${createRes.statusText}`);
  }
  const { job_id: jobId } = (await createRes.json()) as { job_id: string };

  // Poll until completed/failed.
  while (true) {
    const statusRes = await fetch(`${BASE_URL}/v1/jobs/${jobId}`, {
      headers: authHeaders(),
    });
    if (!statusRes.ok) {
      throw new Error(`Status check failed: ${statusRes.status} ${statusRes.statusText}`);
    }
    const status = (await statusRes.json()) as { status: string; error?: string };
    log.debug(`Generic parser job ${jobId}: ${status.status}`);
    if (status.status === "completed") break;
    if (status.status === "failed") {
      throw new Error(`PDF parsing failed: ${status.error ?? "unknown error"}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const resultRes = await fetch(`${BASE_URL}/v1/jobs/${jobId}/result`, {
    headers: authHeaders(),
  });
  if (!resultRes.ok) {
    throw new Error(`Result retrieval failed: ${resultRes.status} ${resultRes.statusText}`);
  }
  return (await resultRes.json()) as RawResult;
};

export const parsePdfFileAsMarkdownGeneric: PdfParser = async (
  file,
  context,
  options
) => {
  if (!API_KEY) throw new Error("No API key set for generic parsing service.");
  if (!BASE_URL) throw new Error("No base URL set for generic parsing service.");

  const form = buildForm(file, options);
  const data = MODE === "async" ? await runAsync(form) : await runSync(form);

  // Save images + replace placeholders (identical to the Mistral parser).
  // An image is stored whenever the service sent a payload — the caller's
  // `extractImages` flag does not veto that. A reference we cannot resolve is
  // removed rather than left behind as a dead link.
  let includesImages = false;
  for (const page of data.pages) {
    const { text, savedPaths } = await resolveImageReferences(
      page.text,
      page.images ?? [],
      context.tenantId
    );
    page.text = text;
    if (savedPaths.length > 0) includesImages = true;
  }

  return {
    model: data.model ?? PDF_PARSER.GENERIC,
    pages: data.pages.map((p) => ({ page: p.page, text: p.text })),
    includesImages,
    metadata: data.metadata,
  };
};
```

---

## 4. Capability discovery

The service advertises which **modalities** (document types) it accepts via
`GET /v1/capabilities` (see the microservice spec §2.1). This lets the framework
route a file to the service only when its type is supported, and know which
request options (`extract_images`, `extract`, async) are meaningful.

### 4.1 Types — `src/lib/knowledge/parsing/pdf/types.ts`

```ts
export type ParserModality =
  | "pdf" | "image" | "audio" | "video" | "text" | "office";

export type ServiceModality = {
  modality: ParserModality;
  mimeTypes: string[];
  extensions: string[];
  features?: {
    extractImages?: boolean;
    extractFields?: boolean;
    async?: boolean;
    /** Extra services (§2.1.1), advertised per modality. */
    parseImagesInDoc?: boolean;
    ocr?: boolean;
    detectTables?: boolean;
  };
};

export type ServiceCapabilities = {
  service: string;
  modalities: ServiceModality[];
};
```

### 4.2 Fetch + cache — `src/lib/knowledge/parsing/pdf/generic.ts`

```ts
let cachedCapabilities: ServiceCapabilities | null = null;

export const getGenericParserCapabilities =
  async (): Promise<ServiceCapabilities> => {
    if (cachedCapabilities) return cachedCapabilities;
    if (!API_KEY || !BASE_URL) {
      throw new Error("Generic parsing service not configured.");
    }
    const res = await fetch(`${BASE_URL}/v1/capabilities`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Capabilities fetch failed: ${res.status} ${res.statusText}`);
    }
    const raw = (await res.json()) as {
      service: string;
      modalities: {
        modality: ServiceModality["modality"];
        mime_types: string[];
        extensions: string[];
        features?: Record<string, boolean>;
      }[];
    };
    cachedCapabilities = {
      service: raw.service,
      modalities: raw.modalities.map((m) => ({
        modality: m.modality,
        mimeTypes: m.mime_types,
        extensions: m.extensions,
        features: {
          extractImages: m.features?.extract_images ?? false,
          extractFields: m.features?.extract_fields ?? false,
          async: m.features?.async ?? false,
        },
      })),
    };
    return cachedCapabilities;
  };

/** True if the service accepts a file of this MIME type / extension. */
export const genericParserSupports = async (
  mimeType?: string,
  extension?: string
): Promise<boolean> => {
  const caps = await getGenericParserCapabilities();
  return caps.modalities.some(
    (m) =>
      (mimeType && m.mimeTypes.includes(mimeType)) ||
      (extension && m.extensions.includes(extension.toLowerCase()))
  );
};
```

The wire field names are `snake_case` (`mime_types`, `extract_images`); the
mapper normalizes them to the framework's `camelCase` types. Capabilities are
cached in-process — the service guarantees a cheap, stable response.

---

## 5. Registration — `src/lib/knowledge/parsing/pdf/index.ts`

One line in the registry:

```ts
const PDF_PARSERS: Record<string, PdfParser> = {
  [PDF_PARSER.SYMBIOSIKA_V1]: parsePdfFileAsMarkdownSymbiosika,
  [PDF_PARSER.MISTRAL]: parsePdfFileAsMarkdownMistral,
  [PDF_PARSER.MISTRAL_OPENROUTER]: parsePdfFileAsMarkdownMistralOpenRouter,
  [PDF_PARSER.LLAMA]: parsePdfFileAsMarkdownLlama,
  [PDF_PARSER.GENERIC]: parsePdfFileAsMarkdownGeneric, // <-- new
};
```

`parsePdfFileAsMardown` reads `PDF_PARSER_SERVICE=generic`, resolves the parser,
and returns the `PdfParserResult` into the existing splitter/embedding pipeline
unchanged.

---

## 6. Open items (not blocking the wire contract)

- **Where do `extract` targets come from?** ✅ Done — the tenant's catalog
  attribute definitions are used as the source, gated by the global
  `enablePdfParserExtraction` flag (see §1.1). A call site may still pass an
  explicit `options.extract` to override.
- **Persisting `metadata`.** ✅ Done — extracted values are written onto the
  page's `attributes` (wiki import) / entry `meta` (RAG), with the raw result
  kept under `meta.parserExtraction`. Consuming it further (required-field
  validation, confidence thresholds) can still follow later.
- **Sync vs. async selection.** Currently a global `PDF_PARSER_SERVICE_MODE`.
  Could later be per-document (e.g. by file size) without a contract change.
- **Modality-based routing.** `genericParserSupports()` enables routing files to
  the service only for advertised modalities (PDF/image/audio/video). Extending
  the parser registry beyond PDF to a general "file parser" dispatcher is a
  follow-up; the capability contract already supports it.

---

## 7. Exposing capabilities + pass-through options to a UI

The extra-service flags (`parse_images_in_doc`, `ocr`, `detect_tables`) are
opt-in per request. So a UI can offer only the options the configured service
actually supports, the framework surfaces them end-to-end:

- **`getConfiguredParserCapabilities()`** (`parsing/pdf/index.ts`) resolves the
  capabilities of the *currently configured* parser: for `generic` it returns
  the cached `GET /v1/capabilities` response; for the hosted services it returns
  a static declaration from `STATIC_PARSER_CAPABILITIES` (the Mistral parsers
  advertise `pdf` + `extractImages`); for anything else an empty `modalities`
  list (nothing to offer). It never throws — a discovery failure degrades to
  "no advertised capabilities". A parser missing from the map advertises
  nothing, which means the import UI renders no checkbox for it and the user
  cannot opt into any pass-through flag — so add an entry when a parser gains a
  caller-controlled option.
- **`GET /tenant/:tenantId/knowledge/parser/capabilities`** exposes that to the
  client (scope `knowledge:read`).
- **`POST /tenant/:tenantId/knowledge/texts/import`** now also accepts the
  pass-through form fields `extractImages`, `parseImagesInDoc`, `ocr`,
  `detectTables` (all `"true"`/absent). They travel through the ingest job into
  `importKnowledgeTextFromFile` → `fileToMarkdown` → `parseFile` →
  `parsePdfFileAsMardown`, where `generic.ts buildForm()` maps each to its
  `snake_case` wire field. A service that does not support a flag ignores it.

The single source of truth for the camelCase key ↔ snake_case wire mapping is
`PARSER_PASSTHROUGH_FLAGS` in `parsing/pdf/types.ts`.
