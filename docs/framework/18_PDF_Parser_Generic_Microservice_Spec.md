# Generic PDF Parser — Microservice Specification

This is the complete, self-contained contract for a **generic PDF parsing
microservice** that plugs into the Symbiosika framework. Implement this and your
service is a drop-in parser — no framework code changes needed, only
configuration.

> Framework-side integration (types, parser wiring) is documented separately in
> `19_PDF_Parser_Generic_Framework_Integration.md`. You do **not** need it to
> build the service.

---

## 1. Authentication

Every request carries an API key in the `X-API-Key` header:

```
X-API-Key: sk-abc123...
```

Reject any request with a missing or wrong key with `401` and body
`{ "error": "invalid_api_key" }`.

---

## 2. Endpoints

| Method | Path                   | Mode  | Required |
|--------|------------------------|-------|----------|
| `GET`  | `/health`              | –     | optional |
| `GET`  | `/v1/capabilities`     | –     | **yes**  |
| `POST` | `/v1/parse`            | sync  | **yes**  |
| `POST` | `/v1/jobs`             | async | optional |
| `GET`  | `/v1/jobs/:id`         | async | optional |
| `GET`  | `/v1/jobs/:id/result`  | async | optional |

You MUST implement `/v1/capabilities` (§2.1) and synchronous `/v1/parse`. The
async job endpoints are OPTIONAL and only needed for large documents where one
HTTP request would exceed proxy/load-balancer timeouts (typically 30–60 s). The
**result body is identical** for sync and async (§5).

### 2.1 Capability discovery — `GET /v1/capabilities`

Declares which **modalities** (document types) the service can process, so the
framework knows whether to route a given file to it. A service is not limited to
PDF — it can advertise images, audio, video, etc. All modalities go through the
same `/v1/parse` (and job) endpoints; the file's content type identifies it.

```bash
curl https://parser.example.com/v1/capabilities -H "X-API-Key: sk-abc123..."
```

```json
{
  "service": "generic-v1",
  "modalities": [
    {
      "modality": "pdf",
      "mime_types": ["application/pdf"],
      "extensions": [".pdf"],
      "features": { "extract_images": true, "extract_fields": true, "async": true }
    },
    {
      "modality": "image",
      "mime_types": ["image/png", "image/jpeg", "image/webp"],
      "extensions": [".png", ".jpg", ".jpeg", ".webp"],
      "features": { "extract_fields": true }
    },
    {
      "modality": "audio",
      "mime_types": ["audio/mpeg", "audio/wav"],
      "extensions": [".mp3", ".wav"],
      "features": { "async": true }
    }
  ]
}
```

| Field                  | Type      | Required | Description |
|------------------------|-----------|----------|-------------|
| `service`              | string    | ✅       | Service/build identifier (matches `model` in results). |
| `modalities`           | array     | ✅       | Every modality the service accepts. At least one entry. |
| `modalities[].modality`| string    | ✅       | Canonical class: `pdf`, `image`, `audio`, `video`, `text`, or `office`. |
| `modalities[].mime_types` | string[] | ✅    | Accepted MIME types for this modality. Used as the primary routing key. |
| `modalities[].extensions` | string[] | ✅    | Accepted file extensions (lowercase, leading dot). Fallback when MIME is unknown. |
| `modalities[].features` | object   | ❌       | Optional per-modality flags: `extract_images`, `extract_fields`, `async` (all default `false`). Tells the framework which request options are meaningful for this type. |

The response MUST be stable and cheap (no file processing). The framework may
cache it. `/v1/parse` MUST reject a file whose type is not in any advertised
modality with `415` `{ "error": "unsupported_modality" }`.

---

## 3. Request payload (same for `/v1/parse` and `/v1/jobs`)

`multipart/form-data`:

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
| `extract`        | JSON string       | ❌       | `[]`    | Structured extraction targets (see §3.1) |

### 3.1 The `extract` field — structured extraction targets

A JSON array. Each entry declares one value to pull out of the document. The
caller names the fields (`key`, `name`, `description`); your service fills them.

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
| `key`         | string    | ✅       | Stable machine key. Use it verbatim as the key in the response `metadata`. `snake_case` recommended. |
| `name`        | string    | ✅       | Human-readable label. Feed it to the extraction model as the field name. |
| `description` | string    | ✅       | What exactly to extract — the primary instruction to the extractor. |
| `required`    | boolean   | ❌ (default `false`) | Whether the field is expected to exist. See below. |
| `type`        | string    | ❌ (default `"string"`) | One of `string`, `number`, `date`, `boolean`, `enum`. `date` values are ISO-8601 strings. |
| `options`     | string[]  | ❌       | Only for `type: "enum"`. Allowed values. |

**Required fields:** a `required` field that cannot be found MUST still appear in
`metadata` with `found: false` and `value: null`. **Do NOT fail the request**
because a required field is missing — the framework decides how to handle gaps.
List every missing required `key` in the top-level `warnings` array.

---

## 4. Synchronous endpoint — `POST /v1/parse`

Parse and return the result in one request. Response is the result object (§5).

```bash
curl -X POST https://parser.example.com/v1/parse \
  -H "X-API-Key: sk-abc123..." \
  -F "file=@muster.pdf;type=application/pdf" \
  -F "extract_images=true" \
  -F 'extract=[{"key":"hersteller","name":"Hersteller","description":"Name des Herstellers","required":true}]'
```

---

## 5. Result object (returned by `/v1/parse` and `/v1/jobs/:id/result`)

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
    { "page": 2, "text": "Weitere technische Daten ..." }
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
| `model`    | string  | ✅       | Free-form identifier of your parser build, e.g. `generic-v1`, `docling-0.3`. |
| `pages`    | array   | ✅       | One entry per page, `page` 1-based and ascending. |
| `metadata` | object  | ❌       | Extracted key/value results, keyed by each `extract` target's `key`. Omit or `{}` when no targets were requested. |
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

**Image placeholders:** every image referenced in `text` MUST use the id as both
alt-text and URL: `![img-p1-1](img-p1-1)`. The framework replaces this with the
real storage path after saving the image.

### `metadata[key]` — extracted value

| Field        | Type              | Required | Description |
|--------------|-------------------|----------|-------------|
| `value`      | string/number/bool/null | ✅ | The extracted value, typed per the target's `type`. `null` when not found. |
| `found`      | boolean           | ✅       | `true` if a value was extracted. |
| `confidence` | number (0..1)     | ❌       | Optional extraction confidence. |
| `page`       | number            | ❌       | Optional 1-based page where the value was found. |

---

## 6. Asynchronous endpoints (optional)

For large documents. Same request payload as `/v1/parse` (§3). Three steps:
**create → poll → fetch result.**

### 6.1 Create — `POST /v1/jobs`

Same multipart body as `/v1/parse`. Returns immediately with `202 Accepted`:

```bash
curl -X POST https://parser.example.com/v1/jobs \
  -H "X-API-Key: sk-abc123..." \
  -F "file=@muster.pdf;type=application/pdf" \
  -F "extract_images=true" \
  -F 'extract=[{"key":"hersteller","name":"Hersteller","description":"...","required":true}]'
```

```json
// 202 Accepted
{ "job_id": "job_7f3a9c", "status": "pending" }
```

### 6.2 Poll — `GET /v1/jobs/:id`

```bash
curl https://parser.example.com/v1/jobs/job_7f3a9c \
  -H "X-API-Key: sk-abc123..."
```

```json
// still running
{ "job_id": "job_7f3a9c", "status": "processing", "progress": 0.4 }

// done
{ "job_id": "job_7f3a9c", "status": "completed" }

// failed
{ "job_id": "job_7f3a9c", "status": "failed", "error": "cannot_parse" }
```

| Field      | Type   | Required | Description |
|------------|--------|----------|-------------|
| `job_id`   | string | ✅       | Echoes the id from create. |
| `status`   | string | ✅       | One of `pending`, `processing`, `completed`, `failed`. |
| `progress` | number (0..1) | ❌ | Optional progress hint while `processing`. |
| `error`    | string | ❌       | Error code, present only when `status: "failed"`. |

The framework polls this endpoint (≈ once per second) until `status` is
`completed` or `failed`.

### 6.3 Result — `GET /v1/jobs/:id/result`

Only valid once `status: "completed"`. Returns the **exact same result object as
`/v1/parse`** (§5).

```bash
curl https://parser.example.com/v1/jobs/job_7f3a9c/result \
  -H "X-API-Key: sk-abc123..."
```

```json
// 200 OK — identical schema to POST /v1/parse
{ "model": "generic-v1", "pages": [ ... ], "metadata": { ... }, "warnings": [] }
```

If called before completion, return `409 Conflict`:
`{ "error": "not_ready", "status": "processing" }`.

---

## 7. Errors

Any non-2xx response is treated as a failure. Use a JSON body:

```json
// 401 – missing/invalid API key
{ "error": "invalid_api_key" }

// 415 – file type not in any advertised modality
{ "error": "unsupported_modality" }

// 415 / 422 – corrupt or unsupported file
{ "error": "cannot_parse", "detail": "unsupported or corrupt file" }

// 400 – malformed 'extract' JSON
{ "error": "invalid_extract", "detail": "extract must be a JSON array" }

// 409 – async result requested too early
{ "error": "not_ready", "status": "processing" }
```

A **missing required extraction field is NOT an error** — return the normal
result with `found: false` and a `warnings` entry (§3.1).

---

## 8. Reference implementation (FastAPI)

```python
from fastapi import FastAPI, UploadFile, Form, Header, HTTPException
import json

app = FastAPI()
API_KEY = "sk-abc123..."

def require_key(x_api_key: str):
    if x_api_key != API_KEY:
        raise HTTPException(401, "invalid_api_key")

def build_result(data: bytes, extract_images: bool, extract: str) -> dict:
    try:
        targets = json.loads(extract)
    except json.JSONDecodeError:
        raise HTTPException(400, "invalid_extract")

    pages = your_parser(data, extract_images)        # -> [{page, text, images?}, ...]
    metadata = your_extractor(pages, targets)        # -> {key: {value, found, ...}}
    warnings = [f"required field '{t['key']}' not found"
                for t in targets
                if t.get("required") and not metadata.get(t["key"], {}).get("found")]
    return {"model": "generic-v1", "pages": pages,
            "metadata": metadata, "warnings": warnings}

CAPABILITIES = {
    "service": "generic-v1",
    "modalities": [
        {"modality": "pdf", "mime_types": ["application/pdf"],
         "extensions": [".pdf"],
         "features": {"extract_images": True, "extract_fields": True, "async": True}},
        {"modality": "image", "mime_types": ["image/png", "image/jpeg"],
         "extensions": [".png", ".jpg", ".jpeg"],
         "features": {"extract_fields": True}},
    ],
}
ACCEPTED_MIME = {m for c in CAPABILITIES["modalities"] for m in c["mime_types"]}

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/v1/capabilities")
def capabilities(x_api_key: str = Header(None)):
    require_key(x_api_key)
    return CAPABILITIES

# --- synchronous (required) ---
@app.post("/v1/parse")
async def parse(
    file: UploadFile,
    extract_images: bool = Form(False),
    extract: str = Form("[]"),
    x_api_key: str = Header(None),
):
    require_key(x_api_key)
    if file.content_type not in ACCEPTED_MIME:
        raise HTTPException(415, "unsupported_modality")
    return build_result(await file.read(), extract_images, extract)

# --- asynchronous (optional) ---
@app.post("/v1/jobs", status_code=202)
async def create_job(
    file: UploadFile,
    extract_images: bool = Form(False),
    extract: str = Form("[]"),
    x_api_key: str = Header(None),
):
    require_key(x_api_key)
    job_id = enqueue(await file.read(), extract_images, extract)   # your queue
    return {"job_id": job_id, "status": "pending"}

@app.get("/v1/jobs/{job_id}")
def job_status(job_id: str, x_api_key: str = Header(None)):
    require_key(x_api_key)
    return get_status(job_id)          # {job_id, status, progress?, error?}

@app.get("/v1/jobs/{job_id}/result")
def job_result(job_id: str, x_api_key: str = Header(None)):
    require_key(x_api_key)
    st = get_status(job_id)
    if st["status"] != "completed":
        raise HTTPException(409, {"error": "not_ready", "status": st["status"]})
    return get_result(job_id)          # same schema as /v1/parse
```
