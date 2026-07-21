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
import { saveBase64ImageToStorage } from "./images";
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
  let includesImages = false;
  for (const page of data.pages) {
    for (const img of page.images ?? []) {
      const savedPath = await saveBase64ImageToStorage(
        img.base64,
        img.id,
        context.tenantId
      );
      if (!savedPath) continue;
      includesImages = true;
      const ref = new RegExp(`!\\[${img.id}\\]\\(${img.id}\\)`, "g");
      page.text = page.text.replace(ref, `![${img.id}](${savedPath})`);
    }
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

- **Where do `extract` targets come from?** They need to be plumbed into
  `PdfParserOptions.extract` at the call site (upload/import flow). The contract
  is defined; the UI/config source for the targets is a separate task.
- **Persisting `metadata`.** Store as JSON on the document record. Consuming it
  (search, required-field validation) can follow later.
- **Sync vs. async selection.** Currently a global `PDF_PARSER_SERVICE_MODE`.
  Could later be per-document (e.g. by file size) without a contract change.
- **Modality-based routing.** `genericParserSupports()` enables routing files to
  the service only for advertised modalities (PDF/image/audio/video). Extending
  the parser registry beyond PDF to a general "file parser" dispatcher is a
  follow-up; the capability contract already supports it.
