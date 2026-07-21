import { describe, test, expect, mock, afterEach } from "bun:test";

// Configure the service before the module is evaluated (env is read at import).
process.env.PDF_PARSER_SERVICE_API_KEY = "test-key";
process.env.PDF_PARSER_SERVICE_URL = "https://parser.test";

// The logger imports the DB connection (which connects at import time), so stub
// it to keep this a pure unit test with no DB dependency.
mock.module("../../../log", () => ({
  default: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

// Avoid touching real storage: the image saver just echoes a fake path.
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

const jsonResponse = (body: unknown, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
    json: async () => body,
  }) as unknown as Response;

const pdfFile = () =>
  new File([new Uint8Array([1, 2, 3])], "muster.pdf", {
    type: "application/pdf",
  });

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  resetGenericParserCapabilitiesCache();
});

describe("Generic PDF Parser Service", () => {
  test("sends the expected request and maps the sync result", async () => {
    const calls: { url: string; init: any }[] = [];
    global.fetch = mock(async (url: string, init: any) => {
      calls.push({ url, init });
      return jsonResponse({
        model: "generic-v1",
        pages: [
          {
            page: 1,
            text: "Hersteller ![img-1](img-1)",
            images: [
              { id: "img-1", base64: "data:image/png;base64,AAAA" },
            ],
          },
          { page: 2, text: "Seite zwei" },
        ],
        metadata: {
          hersteller: { value: "Siemens", found: true, confidence: 0.9 },
          typ: { value: null, found: false },
        },
      });
    }) as unknown as typeof fetch;

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

    // Request shape.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://parser.test/v1/parse");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["X-API-Key"]).toBe("test-key");
    const form = calls[0].init.body as FormData;
    expect(form.get("extract_images")).toBe("true");
    expect(JSON.parse(form.get("extract") as string)).toEqual([
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
    expect(result.metadata?.hersteller.value).toBe("Siemens");
    expect(result.metadata?.typ.found).toBe(false);
  });

  test("omits the extract field when no targets are given", async () => {
    let capturedForm: FormData | undefined;
    global.fetch = mock(async (_url: string, init: any) => {
      capturedForm = init.body as FormData;
      return jsonResponse({ model: "generic-v1", pages: [] });
    }) as unknown as typeof fetch;

    const result = await parsePdfFileAsMarkdownGeneric(pdfFile(), {
      tenantId: "tenant-1",
    });

    expect(capturedForm?.get("extract_images")).toBe("false");
    expect(capturedForm?.get("extract")).toBeNull();
    expect(result.includesImages).toBe(false);
    expect(result.metadata).toBeUndefined();
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = mock(async () =>
      jsonResponse({ error: "cannot_parse" }, false)
    ) as unknown as typeof fetch;

    await expect(
      parsePdfFileAsMarkdownGeneric(pdfFile(), { tenantId: "tenant-1" })
    ).rejects.toThrow("Parsing failed");
  });

  test("fetches capabilities, normalizes fields, and caches", async () => {
    let capabilityCalls = 0;
    global.fetch = mock(async (url: string) => {
      capabilityCalls += 1;
      expect(url).toBe("https://parser.test/v1/capabilities");
      return jsonResponse({
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
            },
          },
          {
            modality: "image",
            mime_types: ["image/png"],
            extensions: [".png"],
          },
        ],
      });
    }) as unknown as typeof fetch;

    const caps = await getGenericParserCapabilities();
    expect(caps.service).toBe("generic-v1");
    expect(caps.modalities[0].mimeTypes).toEqual(["application/pdf"]);
    expect(caps.modalities[0].features?.extractImages).toBe(true);
    // Missing features default to false after normalization.
    expect(caps.modalities[1].features?.async).toBe(false);

    // Second call is served from cache — fetch not hit again.
    await getGenericParserCapabilities();
    expect(capabilityCalls).toBe(1);
  });

  test("genericParserSupports matches by mime type and extension", async () => {
    global.fetch = mock(async () =>
      jsonResponse({
        service: "generic-v1",
        modalities: [
          {
            modality: "pdf",
            mime_types: ["application/pdf"],
            extensions: [".pdf"],
          },
          {
            modality: "image",
            mime_types: ["image/png"],
            extensions: [".png"],
          },
        ],
      })
    ) as unknown as typeof fetch;

    expect(await genericParserSupports("application/pdf")).toBe(true);
    // Extension match is case-insensitive.
    expect(await genericParserSupports(undefined, ".PNG")).toBe(true);
    expect(await genericParserSupports("audio/mpeg", ".mp3")).toBe(false);
  });
});
