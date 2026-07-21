# Generic PDF Parser Interface

This document defines the HTTP contract between the Symbiosika framework and a
**generic PDF parsing microservice**. It is written for two audiences:

- **Microservice author** — build a service that conforms to this contract and
  it plugs into the framework with zero framework changes beyond configuration.
- **Framework developer** — how the `generic` parser wires this contract into
  the existing PDF parsing pipeline.

The contract deliberately mirrors the conventions the framework already uses for
the Mistral OCR parser (base64 images inline, `![id](id)` markdown placeholders),
so existing code paths are reused.

---

## 1. Configuration

The framework selects and reaches the service via three environment variables:

```bash
PDF_PARSER_SERVICE="generic"
PDF_PARSER_SERVICE_API_KEY="sk-abc123..."
PDF_PARSER_SERVICE_URL="https://parser.example.com"
```

Authentication uses the `X-API-Key` request header (same scheme as the existing
Symbiosika parser). The service MUST reject any request whose `X-API-Key` does
not match its configured key with `401`.

---

## 2. Endpoints overview

| Method | Path              | Mode  | Required |
|--------|-------------------|-------|----------|
| `GET`  | `/health`         | –     | optional |
| `POST` | `/v1/parse`       | sync  | **yes**  |
| `POST` | `/v1/jobs`        | async | optional |
| `GET`  | `/v1/jobs/:id`    | async | optional |
| `GET`  | `/v1/jobs/:id/result` | async | optional |

A conformant service MUST implement **synchronous** `/v1/parse`. The async job
endpoints are OPTIONAL and only needed for very large documents where a single
HTTP request would exceed proxy/load-balancer timeouts. The response body of
`/v1/jobs/:id/result` is byte-for-byte the same schema as `/v1/parse`.

---

## 3. Request (framework → service)

Sent as `multipart/form-data`:

```
POST /v1/parse HTTP/1.1
Host: parser.example.com
X-API-Key: sk-abc123...
Content-Type: multipart/form-data; boundary=...

--...
Content-Disposition: form-data; name="file"; filename="document.pdf"
Content-Type: application/pdf

<binary>
--...
Content-Disposition: form-data; name="extract_images"

true
--...
Content-Disposition: form-data; name="extract"

[{"key":"hersteller","name":"Hersteller","description":"Name des Herstellers laut Typenschild","required":true,"type":"string"},{"key":"typ","name":"Typ","description":"Typ-/Modellbezeichnung des Geräts","required":false,"type":"string"}]
--...
```

### Form fields

| Field            | Type              | Required | Default | Description |
|------------------|-------------------|----------|---------|-------------|
| `file`           | file (PDF)        | ✅       | –       | The document to parse |
| `extract_images` | `"true"`/`"false"`| ❌       | `false` | Emit extracted images as base64 |
| `extract`        | JSON string       | ❌       | `[]`    | Structured extraction targets (see below) |

### The `extract` field — structured extraction targets

A JSON array. Each entry declares one value the service should try to pull out of
the document. This is a key/value contract: the framework names the fields, the
service fills them.

```json
[
  {
    "key": "hersteller",
    "name": "Hersteller",
    "description": "Name des Herstellers laut Typenschild",
    "required": true,
    "type": "string"
  },
  {
    "key": "typ",
    "name": "Typ",
    "description": "Typ-/Modellbezeichnung des Geräts",
    "required": false,
    "type": "string"
  },
  {
    "key": "baujahr",
    "name": "Baujahr",
    "description": "Herstellungsjahr",
    "required": false,
    "type": "number"
  },
  {
    "key": "geraeteart",
    "name": "Geräteart",
    "description": "Kategorie des Geräts",
    "required": false,
    "type": "enum",
    "options": ["Pumpe", "Ventil", "Motor", "Sonstiges"]
  }
]
```

| Attribute     | Type      | Required | Meaning |
|---------------|-----------|----------|---------|
| `key`         | string    | ✅       | Stable machine key. Used verbatim as the key in the response `metadata` object. `snake_case` recommended. |
| `name`        | string    | ✅       | Human-readable label. Give this to the extraction model as the field name. |
| `description` | string    | ✅       | What exactly to extract. This is the primary instruction to the extractor — be specific. |
| `required`    | boolean   | ❌ (default `false`) | If `true`, the field is expected to exist. See "Required fields" below. |
| `type`        | string    | ❌ (default `"string"`) | One of `string`, `number`, `date`, `boolean`, `enum`. Hints the expected value shape. `date` values are ISO-8601 strings. |
| `options`     | string[]  | ❌       | Only for `type: "enum"`. Allowed values. |

**Required fields:** a `required` field that cannot be found MUST still be
returned in `metadata` with `found: false` and `value: null`. The service MUST
NOT fail the whole request because a required field is missing — the framework
decides how to treat missing required values. The service SHOULD list every
missing required key in the top-level `warnings` array.

---

## 4. Response (service → framework)

`200 OK`, `Content-Type: application/json`:

```json
{
  "model": "generic-v1",
  "pages": [
    {
      "page": 1,
      "text": "# Typenschild\n\nHersteller: Siemens\n\n![img-p1-1](img-p1-1)",
      "images": [
        { "id": "img-p1-1", "base64": "data:image/png;base64,iVBORw0KGgo..." }
      ]
    },
    {
      "page": 2,
      "text": "Weitere technische Daten ..."
    }
  ],
  "metadata": {
    "hersteller": { "value": "Siemens", "found": true, "confidence": 0.96, "page": 1 },
    "typ":        { "value": "3RT2026-1BB40", "found": true, "confidence": 0.88, "page": 1 },
    "baujahr":    { "value": 2021, "found": true, "confidence": 0.72, "page": 2 },
    "geraeteart": { "value": null, "found": false, "confidence": 0 }
  },
  "warnings": []
}
```

### Top-level fields

| Field      | Type    | Required | Description |
|------------|---------|----------|-------------|
| `model`    | string  | ✅       | Free-form identifier of the parser build, e.g. `generic-v1`, `docling-0.3`. Echoed into the framework result for traceability. |
| `pages`    | array   | ✅       | One entry per page, `page` 1-based and ascending. |
| `metadata` | object  | ❌       | The extracted key/value results. Keyed by the `key` from each `extract` target. Omit or `{}` when no `extract` targets were requested. |
| `warnings` | string[]| ❌       | Non-fatal notes, e.g. `"required field 'geraeteart' not found"`. |

### `pages[]`

| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| `page`   | number | ✅       | 1-based page number. |
| `text`   | string | ✅       | Page content as **Markdown**. |
| `images` | array  | ❌       | Extracted images for this page. Only when `extract_images=true`. |

### `pages[].images[]`

| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| `id`     | string | ✅       | Image id, unique within the document. |
| `base64` | string | ✅       | Image bytes. Raw base64 **or** a `data:<mime>;base64,...` URL — both accepted. |

**Image placeholders:** each image referenced in `text` MUST use the id as both
alt-text and URL: `![img-p1-1](img-p1-1)`. The framework replaces this
placeholder with the real storage path after saving the image. (This is exactly
the Mistral OCR convention.)

### `metadata[key]` — extracted value

| Field        | Type              | Required | Description |
|--------------|-------------------|----------|-------------|
| `value`      | string/number/bool/null | ✅ | The extracted value, typed per the target's `type`. `null` when not found. |
| `found`      | boolean           | ✅       | `true` if a value was extracted. |
| `confidence` | number (0..1)     | ❌       | Optional extraction confidence. |
| `page`       | number            | ❌       | Optional 1-based page where the value was found. |

The framework persists the entire `metadata` object as JSON on the document. It
does not yet act on `confidence`/`page`, but the shape is defined now so services
can populate it and the framework can use it later without a contract change.

---

## 5. Errors

Any non-2xx response is treated as a failure by the framework. Use a JSON body:

```json
// 401 – missing/invalid API key
{ "error": "invalid_api_key" }

// 415 / 422 – corrupt or unsupported file
{ "error": "cannot_parse", "detail": "unsupported or corrupt PDF" }

// 400 – malformed 'extract' JSON
{ "error": "invalid_extract", "detail": "extract must be a JSON array" }
```

A **missing required extraction field is NOT an error** — return `200` with
`found: false` and a `warnings` entry (see §3).

---

## 6. Microservice reference (FastAPI)

```python
from fastapi import FastAPI, UploadFile, Form, Header, HTTPException
import json

app = FastAPI()
API_KEY = "sk-abc123..."

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/v1/parse")
async def parse(
    file: UploadFile,
    extract_images: bool = Form(False),
    extract: str = Form("[]"),
    x_api_key: str = Header(None),
):
    if x_api_key != API_KEY:
        raise HTTPException(401, "invalid_api_key")

    try:
        targets = json.loads(extract)
    except json.JSONDecodeError:
        raise HTTPException(400, "invalid_extract")

    data = await file.read()

    pages = your_parser(data, extract_images)          # -> [{page, text, images?}, ...]
    metadata = your_extractor(pages, targets)          # -> {key: {value, found, ...}}
    warnings = [f"required field '{t['key']}' not found"
                for t in targets
                if t.get("required") and not metadata.get(t["key"], {}).get("found")]

    return {
        "model": "generic-v1",
        "pages": pages,
        "metadata": metadata,
        "warnings": warnings,
    }
```

---

## 7. Framework integration

### 7.1 Types (`src/lib/knowledge/parsing/pdf/types.ts`)

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
  /** Structured extraction targets passed to the service. */
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

### 7.2 Parser (`src/lib/knowledge/parsing/pdf/generic.ts`)

```ts
const API_KEY = process.env.PDF_PARSER_SERVICE_API_KEY;
const BASE_URL = process.env.PDF_PARSER_SERVICE_URL;

export const parsePdfFileAsMarkdownGeneric: PdfParser = async (
  file, context, options
) => {
  if (!API_KEY) throw new Error("No API key set for generic parsing service.");
  if (!BASE_URL) throw new Error("No base URL set for generic parsing service.");

  const formData = new FormData();
  formData.append("file", file, "document.pdf");
  formData.append("extract_images", String(options?.extractImages ?? false));
  if (options?.extract?.length) {
    formData.append("extract", JSON.stringify(options.extract));
  }

  const res = await fetch(`${BASE_URL}/v1/parse`, {
    method: "POST",
    headers: { "X-API-Key": API_KEY },
    body: formData,
  });
  if (!res.ok) throw new Error(`Parsing failed: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as {
    model: string;
    pages: { page: number; text: string; images?: { id: string; base64: string }[] }[];
    metadata?: Record<string, ExtractedValue>;
  };

  // Save images + replace placeholders (identical to the Mistral parser).
  let includesImages = false;
  for (const page of data.pages) {
    for (const img of page.images ?? []) {
      const savedPath = await saveBase64ImageToStorage(img.base64, img.id, context.tenantId);
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

### 7.3 Registration (`src/lib/knowledge/parsing/pdf/index.ts`)

```ts
const PDF_PARSERS: Record<string, PdfParser> = {
  // ...existing...
  [PDF_PARSER.GENERIC]: parsePdfFileAsMarkdownGeneric,
};
```

Nothing else changes: `parsePdfFileAsMardown` reads `PDF_PARSER_SERVICE=generic`,
resolves the parser, and the returned `PdfParserResult` flows into the existing
splitter/embedding pipeline. The new `metadata` field can be persisted as JSON on
the document today; downstream consumption can be added later without touching
this contract.
```
