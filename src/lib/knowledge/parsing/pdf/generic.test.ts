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

// Stub only the storage write, so the reference-resolving logic in ./images
// (rewrite on success, strip on failure) runs for real.
const savedBuckets: string[] = [];
mock.module("../../../storage", () => ({
  saveFile: async (file: File, bucket: string) => {
    savedBuckets.push(bucket);
    return { path: `/storage/${file.name}` };
  },
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
const { PARSED_IMAGES_BUCKET } = await import("./images");
// The public parsing entry point the knowledge-page importer calls. Exercised
// here so the `imageBucket` option is covered over the whole path it travels
// (parseFile → parseFileWithService → parser → image storage), not just at
// the parser's own doorstep.
const { parseFile } = await import("../index");

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
let jobsCreated = 0;
let failNextParse = false;
/** Overrides RESULT_BODY for a single parse, reset in afterEach. */
let nextResultBody: unknown = null;

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
    // Mirrors the running service's registry: everything non-media is one
    // `document` modality — never `ocr` (nothing is recognised, the structure
    // is in the file) and never `include_positions` (no rendering, no
    // geometry).
    {
      modality: "document",
      mime_types: [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "text/plain",
        "text/markdown",
        "text/csv",
        "text/tab-separated-values",
        "message/rfc822",
      ],
      extensions: [
        ".docx",
        ".xlsx",
        ".pptx",
        ".txt",
        ".log",
        ".md",
        ".csv",
        ".tsv",
        ".eml",
      ],
      features: {
        extract_images: true,
        extract_fields: true,
        async: true,
        detect_tables: true,
        preferred_language: true,
        parse_images_in_doc: true,
        polish_markdown: true,
      },
    },
    // Audio advertises `async` and nothing else — it rejects `extract` and
    // `extract_images=true` outright.
    {
      modality: "audio",
      mime_types: ["audio/mpeg", "audio/ogg", "audio/opus"],
      extensions: [".mp3", ".ogg", ".opus"],
      features: { async: true },
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

/** Record what the framework sent, for both the sync and the job entry point. */
const recordForm = async (req: Request): Promise<void> => {
  const form = await req.formData();
  lastParseForm = {
    filename: (form.get("file") as File | null)?.name,
    extractImages: form.get("extract_images") as string | null,
    extract: form.get("extract") as string | null,
    parseImagesInDoc: form.get("parse_images_in_doc") as string | null,
    ocr: form.get("ocr") as string | null,
    detectTables: form.get("detect_tables") as string | null,
  };
};

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
        await recordForm(req);
        if (failNextParse) {
          return Response.json({ error: "cannot_parse" }, { status: 422 });
        }
        return Response.json(nextResultBody ?? RESULT_BODY);
      }

      if (url.pathname === "/v1/jobs" && req.method === "POST") {
        await recordForm(req);
        jobsCreated += 1;
        const jobId = `job_${(jobCounter += 1)}`;
        jobs.add(jobId);
        return Response.json(
          { job_id: jobId, status: "pending" },
          { status: 202 },
        );
      }

      const jobResultMatch = url.pathname.match(
        /^\/v1\/jobs\/([^/]+)\/result$/,
      );
      if (jobResultMatch) {
        return jobs.has(jobResultMatch[1]!)
          ? Response.json(nextResultBody ?? RESULT_BODY)
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
  savedBuckets.length = 0;
  lastParseForm = null;
  jobsCreated = 0;
  failNextParse = false;
  nextResultBody = null;
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
      },
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

  test("stores an image the service sent even when extractImages was not set", async () => {
    // Regression guard: the decision to store is driven by the payload, not by
    // the caller's flag. A service that hands us base64 anyway must still get
    // its image persisted — that was the behaviour before the reference
    // cleanup and dropping it would silently lose images.
    const result = await parsePdfFileAsMarkdownGeneric(pdfFile(), {
      tenantId: "tenant-1",
    });

    expect(lastParseForm?.extractImages).toBe("false");
    expect(result.includesImages).toBe(true);
    expect(result.pages?.[0]?.text).toBe("Hersteller ![img-1](/storage/img-1)");
  });

  test("stores extracted images in the parsed-images bucket by default", async () => {
    await parsePdfFileAsMarkdownGeneric(pdfFile(), { tenantId: "tenant-1" });

    expect(savedBuckets).toEqual([PARSED_IMAGES_BUCKET]);
  });

  test("parseFile routes extracted images into the requested bucket", async () => {
    // The knowledge-page importer passes the page image bucket here so an
    // imported document's pictures land where a page's own images live.
    process.env.PDF_PARSER_SERVICE = "generic";

    const result = await parseFile(pdfFile(), { tenantId: "tenant-1" }, {
      extractImages: true,
      imageBucket: "knowledge",
    });

    expect(savedBuckets).toEqual(["knowledge"]);
    expect(result.text).toContain("![img-1](/storage/img-1)");
  });

  test("strips placeholders for images the service listed but did not send", async () => {
    nextResultBody = {
      model: "generic-v1",
      pages: [
        {
          page: 1,
          text: "Hersteller ![img-1](img-1)",
          images: [{ id: "img-1", base64: null }],
        },
      ],
    };

    const result = await parsePdfFileAsMarkdownGeneric(pdfFile(), {
      tenantId: "tenant-1",
    });

    expect(result.includesImages).toBe(false);
    expect(result.pages?.[0]?.text).toBe("Hersteller");
    expect(result.pages?.[0]?.text).not.toContain("![");
  });

  test("writes a reported image description below the image", async () => {
    // `parse_images_in_doc` services describe what is ON the picture. Without
    // this the description would be dropped and the imported image would stay
    // a dead path for search, embedding and every AI reader.
    nextResultBody = {
      model: "generic-v1",
      pages: [
        {
          page: 1,
          text: "Aufbau ![img-1](img-1)",
          images: [
            {
              id: "img-1",
              base64: "data:image/png;base64,AAAA",
              description: "Schaltplan der Steuerplatine\nmit Netzteil links",
            },
          ],
        },
      ],
    };

    const result = await parsePdfFileAsMarkdownGeneric(
      pdfFile(),
      { tenantId: "tenant-1" },
      { extractImages: true, parseImagesInDoc: true },
    );

    expect(result.pages?.[0]?.text).toBe(
      "Aufbau ![img-1](/storage/img-1)\n" +
        '<image-description src="/storage/img-1">' +
        "Schaltplan der Steuerplatine mit Netzteil links" +
        "</image-description>",
    );
  });

  test("adds nothing when the service reports no description", async () => {
    const result = await parsePdfFileAsMarkdownGeneric(pdfFile(), {
      tenantId: "tenant-1",
    });

    expect(result.pages?.[0]?.text).toBe("Hersteller ![img-1](/storage/img-1)");
    expect(result.pages?.[0]?.text).not.toContain("image-description");
  });

  test("leaves a page without dropped images byte-identical", async () => {
    // Nothing was stripped, so no whitespace reflow may happen: the trailing
    // double space is a markdown hard line break and must survive.
    const text = "Zeile eins  \nZeile zwei\n\n```\ncode\n\n\nEnde\n```\n";
    nextResultBody = { model: "generic-v1", pages: [{ page: 1, text }] };

    const result = await parsePdfFileAsMarkdownGeneric(pdfFile(), {
      tenantId: "tenant-1",
    });

    expect(result.pages?.[0]?.text).toBe(text);
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
      { ocr: true, parseImagesInDoc: true, detectTables: true },
    );
    expect(lastParseForm?.ocr).toBe("true");
    expect(lastParseForm?.parseImagesInDoc).toBe("true");
    expect(lastParseForm?.detectTables).toBe("true");
  });

  test("throws on a non-2xx response", async () => {
    failNextParse = true;
    await expect(
      parsePdfFileAsMarkdownGeneric(pdfFile(), { tenantId: "tenant-1" }),
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
    // Advertised since the service grew audio; a format it does not list at
    // all is still a no.
    expect(await genericParserSupports("audio/mpeg", ".mp3")).toBe(true);
    expect(await genericParserSupports("application/msword", ".doc")).toBe(
      false,
    );
  });

  test("getConfiguredParserCapabilities returns generic caps when configured", async () => {
    process.env.PDF_PARSER_SERVICE = "generic";
    const caps = await getConfiguredParserCapabilities();
    expect(caps.service).toBe("generic-v1");
    expect(caps.modalities[0]!.features?.ocr).toBe(true);
    expect(caps.modalities[0]!.features?.detectTables).toBe(true);
  });

  test("getConfiguredParserCapabilities serves static caps for Mistral", async () => {
    // Without this the import UI renders no checkbox at all and the user has
    // no way to opt into image extraction.
    process.env.PDF_PARSER_SERVICE = "mistral";
    const caps = await getConfiguredParserCapabilities();
    expect(caps.service).toBe("mistral");
    expect(caps.modalities[0]!.modality).toBe("pdf");
    expect(caps.modalities[0]!.features?.extractImages).toBe(true);
  });

  test("getConfiguredParserCapabilities advertises nothing for a parser without options", async () => {
    process.env.PDF_PARSER_SERVICE = "llama";
    const caps = await getConfiguredParserCapabilities();
    expect(caps.service).toBe("llama");
    expect(caps.modalities).toEqual([]);
  });

  test("getConfiguredParserCapabilities advertises nothing for the default parser", async () => {
    const caps = await getConfiguredParserCapabilities();
    expect(caps.modalities).toEqual([]);
  });
});

// --- Routing: parseFile asks the service, it does not guess -----------------

describe("parseFile routing against the advertised capabilities", () => {
  /** The routing question goes to the *configured* service. */
  const useGenericService = () => {
    process.env.PDF_PARSER_SERVICE = "generic";
  };
  const upload = (name: string, type: string, body = "irrelevant") =>
    new File([body], name, { type });

  test("a .docx reaches the service instead of being rejected", async () => {
    // This is the error that reached end users: "Unsupported file type for
    // parsing: …wordprocessingml.document".
    useGenericService();

    const result = await parseFile(
      upload(
        "bericht.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
      { tenantId: "tenant-1" },
    );

    expect(lastParseForm?.filename).toBe("bericht.docx");
    expect(result.text).toContain("Seite zwei");
  });

  test("an .eml reaches the service", async () => {
    useGenericService();

    const result = await parseFile(upload("mail.eml", "message/rfc822"), {
      tenantId: "tenant-1",
    });

    expect(lastParseForm?.filename).toBe("mail.eml");
    expect(result.text).toContain("Seite zwei");
  });

  test("a .csv arriving as text/plain goes to the service, not the local text path", async () => {
    // Browsers label .csv as text/plain all the time. Reading it locally would
    // throw away the whole table layer, so the extension beats the MIME here.
    useGenericService();

    const result = await parseFile(
      upload("tabelle.csv", "text/plain", "Name;Wert\nA;1"),
      { tenantId: "tenant-1" },
    );

    expect(lastParseForm?.filename).toBe("tabelle.csv");
    expect(result.text).not.toContain("Name;Wert");
  });

  test("a .xlsx with a generic MIME is recognised by its extension", async () => {
    useGenericService();

    const result = await parseFile(
      upload("zahlen.xlsx", "application/octet-stream"),
      { tenantId: "tenant-1" },
    );

    expect(lastParseForm?.filename).toBe("zahlen.xlsx");
    expect(result.text).toContain("Seite zwei");
  });

  test("markdown stays in-house — no service call", async () => {
    useGenericService();

    const result = await parseFile(
      upload("notiz.md", "text/markdown", "# Titel\n\nText"),
      { tenantId: "tenant-1" },
    );

    expect(result.text).toBe("# Titel\n\nText");
    expect(lastParseForm).toBeNull();
  });

  test("plain text stays in-house — no service call", async () => {
    useGenericService();

    const result = await parseFile(
      upload("log.txt", "text/plain; charset=utf-8", "Zeile"),
      { tenantId: "tenant-1" },
    );

    expect(result.text).toBe("Zeile");
    expect(lastParseForm).toBeNull();
  });

  test("html stays in-house — the service rejects it on purpose", async () => {
    useGenericService();

    const result = await parseFile(
      upload("seite.html", "text/html", "<h1>Titel</h1><p>Text</p>"),
      { tenantId: "tenant-1" },
    );

    expect(result.text).toBe("# Titel\n\nText");
    expect(lastParseForm).toBeNull();
  });

  test("a format nobody advertises is still rejected", async () => {
    // .doc / .xls / .ppt were checked and deliberately dropped on the service
    // side — not "not yet".
    useGenericService();

    await expect(
      parseFile(upload("alt.doc", "application/msword"), {
        tenantId: "tenant-1",
      }),
    ).rejects.toThrow("Unsupported file type for parsing");
    expect(lastParseForm).toBeNull();
  });

  test("an image is parsed instead of yielding the NOT IMPLEMENTED literal", async () => {
    // That string used to be written into the index as the page's text.
    useGenericService();

    const result = await parseFile(upload("bild.png", "image/png"), {
      tenantId: "tenant-1",
    });

    expect(result.text).not.toContain("NOT IMPLEMENTED");
    expect(result.text).toContain("Seite zwei");
    expect(lastParseForm?.filename).toBe("bild.png");
  });

  test("warnings from a service response reach the parseFile result", async () => {
    // A partial result that does not say so is a result that lies.
    useGenericService();
    nextResultBody = {
      model: "generic-v1",
      pages: [{ page: 1, text: "Teiltranskript" }],
      warnings: ["transcription_incomplete:80/120"],
    };

    const result = await parseFile(upload("rede.mp3", "audio/mpeg"), {
      tenantId: "tenant-1",
    });

    expect(result.warnings).toEqual(["transcription_incomplete:80/120"]);
  });

  test("audio takes the job path even while the service mode is sync", async () => {
    // A one-hour recording would hold a single HTTP request open for the whole
    // transcription and time out.
    useGenericService();

    const result = await parseFile(
      upload("sprachnachricht.opus", "application/octet-stream"),
      { tenantId: "tenant-1" },
      {
        extractImages: true,
        extract: [{ key: "k", name: "K", description: "d" }],
      },
    );

    expect(jobsCreated).toBe(1);
    expect(result.text).toContain("Seite zwei");
    // Audio advertises neither, and rejects both with `unsupported_option`.
    expect(lastParseForm?.extractImages).toBe("false");
    expect(lastParseForm?.extract).toBeNull();
  });

  test("does not send an option the target modality does not advertise", async () => {
    // `document` has no `ocr`: nothing is recognised, the structure is in the
    // file. Sending it anyway is noise at best.
    useGenericService();

    await parseFile(
      upload("zahlen.xlsx", "application/octet-stream"),
      { tenantId: "tenant-1" },
      { ocr: true, detectTables: true, preferredLanguage: "de" },
    );

    expect(lastParseForm?.ocr).toBeNull();
    expect(lastParseForm?.detectTables).toBe("true");
  });

  test("an explicitly selected parser decides what is supported", async () => {
    // No PDF_PARSER_SERVICE in the environment: the routing question has to
    // follow `options.model`, or a caller picking `generic` per call would be
    // told its own formats are unsupported.
    const result = await parseFile(
      upload("mail.eml", "message/rfc822"),
      { tenantId: "tenant-1" },
      { model: "generic" },
    );

    expect(lastParseForm?.filename).toBe("mail.eml");
    expect(result.text).toContain("Seite zwei");
  });

  test("the old parsePdfFileAsMardown name still resolves", async () => {
    // Existing callers (e.g. parsing/url.ts before the rename) keep working.
    const { parsePdfFileAsMardown, parseFileWithService } = await import(
      "./index"
    );
    expect(parsePdfFileAsMardown).toBe(parseFileWithService);
  });

  test("PDF survives a capabilities outage", async () => {
    // The static fallback exists for exactly this: discovery is down, PDF
    // imports keep working.
    useGenericService();
    const url = process.env.PDF_PARSER_SERVICE_URL;
    process.env.PDF_PARSER_SERVICE_URL = "http://127.0.0.1:1";
    try {
      await expect(
        parseFile(pdfFile(), { tenantId: "tenant-1" }),
      ).rejects.toThrow(/^(?!Unsupported file type)/);
    } finally {
      process.env.PDF_PARSER_SERVICE_URL = url;
    }
  });
});
