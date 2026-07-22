import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  mock,
} from "bun:test";

// Provide DB env defaults so importing the logger (which constructs a Postgres
// client at module load) does not crash in an isolated run. postgres.js is
// lazy, so no real connection is opened — and nothing here ever queries.
process.env.POSTGRES_HOST ??= "localhost";
process.env.POSTGRES_PORT ??= "5432";
process.env.POSTGRES_USER ??= "postgres";
process.env.POSTGRES_PASSWORD ??= "postgres";
process.env.POSTGRES_DB ??= "symbiosika";

// Stub the image saver so the image-rewrite path does not touch real storage.
// The only other importers are the (disabled) Mistral parser tests.
mock.module("./images", () => ({
  saveBase64ImageToStorage: async (_base64: string, id: string) =>
    `/storage/${id}`,
}));

const {
  parsePdfFileAsMarkdownGeneric,
  getGenericParserCapabilities,
  genericParserSupports,
  resetGenericParserCapabilitiesCache,
} = await import("./generic");

// Registry dispatcher — exercised here so the capability tests reuse the same
// fake service + env this file already stands up.
const { getConfiguredParserCapabilities } = await import("./index");

// --- A mini fake parsing service implementing the wire contract ------------

const API_KEY = "test-key";

// Observable state so tests can assert what the framework actually sent.
let lastParseForm: {
  filename?: string;
  extractImages: string | null;
  extract: string | null;
  parseImagesInDoc: string | null;
  ocr: string | null;
  detectTables: string | null;
} | null = null;
let capabilitiesHits = 0;
let failNextParse = false;

const CAPABILITIES_BODY = {
  service: "generic-v1",
  modalities: [
    {
      modality: "pdf",
      mime_types: ["application/pdf"],
      extensions: [".pdf"],
      features: {
        extract_images: true,
        extract_fields: true,
        async: true,
        parse_images_in_doc: true,
        ocr: true,
        detect_tables: true,
      },
    },
    {
      modality: "image",
      mime_types: ["image/png"],
      extensions: [".png"],
    },
  ],
};

const RESULT_BODY = {
  model: "generic-v1",
  pages: [
    {
      page: 1,
      text: "Hersteller ![img-1](img-1)",
      images: [{ id: "img-1", base64: "data:image/png;base64,AAAA" }],
    },
    { page: 2, text: "Seite zwei" },
  ],
  metadata: {
    hersteller: { value: "Siemens", found: true, confidence: 0.9 },
    typ: { value: null, found: false },
  },
};

// Minimal in-memory job store for the async flow: a created job is immediately
// "completed", so the first status poll succeeds without the 1s backoff.
const jobs = new Set<string>();
let jobCounter = 0;

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.headers.get("X-API-Key") !== API_KEY) {
        return Response.json({ error: "invalid_api_key" }, { status: 401 });
      }

      if (url.pathname === "/v1/capabilities") {
        capabilitiesHits += 1;
        return Response.json(CAPABILITIES_BODY);
      }

      if (url.pathname === "/v1/parse" && req.method === "POST") {
        const form = await req.formData();
        lastParseForm = {
          filename: (form.get("file") as File | null)?.name,
          extractImages: form.get("extract_images") as string | null,
          extract: form.get("extract") as string | null,
          parseImagesInDoc: form.get("parse_images_in_doc") as string | null,
          ocr: form.get("ocr") as string | null,
          detectTables: form.get("detect_tables") as string | null,
        };
        if (failNextParse) {
          return Response.json({ error: "cannot_parse" }, { status: 422 });
        }
        return Response.json(RESULT_BODY);
      }

      if (url.pathname === "/v1/jobs" && req.method === "POST") {
        await req.formData();
        const jobId = `job_${(jobCounter += 1)}`;
        jobs.add(jobId);
        return Response.json({ job_id: jobId, status: "pending" }, { status: 202 });
      }

      const jobResultMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/result$/);
      if (jobResultMatch) {
        return jobs.has(jobResultMatch[1]!)
          ? Response.json(RESULT_BODY)
          : Response.json({ error: "not_ready" }, { status: 409 });
      }

      const jobStatusMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (jobStatusMatch) {
        return jobs.has(jobStatusMatch[1]!)
          ? Response.json({ job_id: jobStatusMatch[1], status: "completed" })
          : Response.json({ error: "unknown_job" }, { status: 404 });
      }

      return new Response("not found", { status: 404 });
    },
  });

  process.env.PDF_PARSER_SERVICE_API_KEY = API_KEY;
  process.env.PDF_PARSER_SERVICE_URL = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  delete process.env.PDF_PARSER_SERVICE_URL;
  delete process.env.PDF_PARSER_SERVICE_API_KEY;
});

afterEach(() => {
  resetGenericParserCapabilitiesCache();
  failNextParse = false;
  delete process.env.PDF_PARSER_SERVICE_MODE;
  delete process.env.PDF_PARSER_SERVICE;
});

const pdfFile = () =>
  new File([new Uint8Array([1, 2, 3])], "muster.pdf", {
    type: "application/pdf",
  });

describe("Generic PDF Parser Service (against a fake service)", () => {
  test("sends the expected request and maps the sync result", async () => {
    const result = await parsePdfFileAsMarkdownGeneric(
      pdfFile(),
      { tenantId: "tenant-1" },
      {
        extractImages: true,
        extract: [
          {
            key: "hersteller",
            name: "Hersteller",
            description: "Name des Herstellers",
            required: true,
          },
        ],
      }
    );

    // What the framework actually sent to the service.
    expect(lastParseForm?.filename).toBe("muster.pdf");
    expect(lastParseForm?.extractImages).toBe("true");
    expect(JSON.parse(lastParseForm?.extract as string)).toEqual([
      {
        key: "hersteller",
        name: "Hersteller",
        description: "Name des Herstellers",
        required: true,
      },
    ]);

    // Result mapping: image placeholder rewritten, metadata passed through.
    expect(result.model).toBe("generic-v1");
    expect(result.includesImages).toBe(true);
    expect(result.pages).toEqual([
      { page: 1, text: "Hersteller ![img-1](/storage/img-1)" },
      { page: 2, text: "Seite zwei" },
    ]);
    expect(result.metadata?.hersteller?.value).toBe("Siemens");
    expect(result.metadata?.typ?.found).toBe(false);
  });

  test("omits the extract field when no targets are given", async () => {
    await parsePdfFileAsMarkdownGeneric(pdfFile(), { tenantId: "tenant-1" });
    expect(lastParseForm?.extractImages).toBe("false");
    expect(lastParseForm?.extract).toBeNull();
  });

  test("omits extra-service flags unless they are enabled", async () => {
    await parsePdfFileAsMarkdownGeneric(pdfFile(), { tenantId: "tenant-1" });
    expect(lastParseForm?.parseImagesInDoc).toBeNull();
    expect(lastParseForm?.ocr).toBeNull();
    expect(lastParseForm?.detectTables).toBeNull();
  });

  test("forwards enabled extra-service flags as multipart fields", async () => {
    await parsePdfFileAsMarkdownGeneric(
      pdfFile(),
      { tenantId: "tenant-1" },
      { ocr: true, parseImagesInDoc: true, detectTables: true }
    );
    expect(lastParseForm?.ocr).toBe("true");
    expect(lastParseForm?.parseImagesInDoc).toBe("true");
    expect(lastParseForm?.detectTables).toBe("true");
  });

  test("throws on a non-2xx response", async () => {
    failNextParse = true;
    await expect(
      parsePdfFileAsMarkdownGeneric(pdfFile(), { tenantId: "tenant-1" })
    ).rejects.toThrow("Parsing failed");
  });

  test("async mode runs create -> poll -> result", async () => {
    process.env.PDF_PARSER_SERVICE_MODE = "async";
    const result = await parsePdfFileAsMarkdownGeneric(pdfFile(), {
      tenantId: "tenant-1",
    });
    expect(result.model).toBe("generic-v1");
    expect(result.pages?.[1]).toEqual({ page: 2, text: "Seite zwei" });
  });

  test("fetches capabilities, normalizes fields, and caches", async () => {
    const before = capabilitiesHits;

    const caps = await getGenericParserCapabilities();
    expect(caps.service).toBe("generic-v1");
    expect(caps.modalities[0]!.mimeTypes).toEqual(["application/pdf"]);
    expect(caps.modalities[0]!.features?.extractImages).toBe(true);
    // Extra-service flags are mapped from snake_case to camelCase.
    expect(caps.modalities[0]!.features?.ocr).toBe(true);
    expect(caps.modalities[0]!.features?.parseImagesInDoc).toBe(true);
    expect(caps.modalities[0]!.features?.detectTables).toBe(true);
    // Missing features default to false after normalization.
    expect(caps.modalities[1]!.features?.async).toBe(false);
    expect(caps.modalities[1]!.features?.ocr).toBe(false);

    // Second call is served from cache — service hit only once.
    await getGenericParserCapabilities();
    expect(capabilitiesHits - before).toBe(1);
  });

  test("genericParserSupports matches by mime type and extension", async () => {
    expect(await genericParserSupports("application/pdf")).toBe(true);
    // Extension match is case-insensitive.
    expect(await genericParserSupports(undefined, ".PNG")).toBe(true);
    expect(await genericParserSupports("audio/mpeg", ".mp3")).toBe(false);
  });

  test("getConfiguredParserCapabilities returns generic caps when configured", async () => {
    process.env.PDF_PARSER_SERVICE = "generic";
    const caps = await getConfiguredParserCapabilities();
    expect(caps.service).toBe("generic-v1");
    expect(caps.modalities[0]!.features?.ocr).toBe(true);
    expect(caps.modalities[0]!.features?.detectTables).toBe(true);
  });

  test("getConfiguredParserCapabilities advertises nothing for a non-generic parser", async () => {
    process.env.PDF_PARSER_SERVICE = "mistral";
    const caps = await getConfiguredParserCapabilities();
    expect(caps.service).toBe("mistral");
    expect(caps.modalities).toEqual([]);
  });

  test("getConfiguredParserCapabilities advertises nothing for the default parser", async () => {
    const caps = await getConfiguredParserCapabilities();
    expect(caps.modalities).toEqual([]);
  });
});
