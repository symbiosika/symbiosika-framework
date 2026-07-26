import { describe, test, expect, afterAll, afterEach, mock } from "bun:test";

// Provide DB env defaults so importing the logger (which constructs a Postgres
// client at module load) does not crash in an isolated run. postgres.js is
// lazy, so no real connection is opened — and nothing here ever queries.
process.env.POSTGRES_HOST ??= "localhost";
process.env.POSTGRES_PORT ??= "5432";
process.env.POSTGRES_USER ??= "postgres";
process.env.POSTGRES_PASSWORD ??= "postgres";
process.env.POSTGRES_DB ??= "symbiosika";

// The parser reads the key at module load, so it has to exist before import.
process.env.MISTRAL_API_KEY ??= "test-key";

// Stub the image saver so the image-rewrite path does not touch real storage.
// It keeps the null guard of the real implementation, so a null payload does
// not silently pass here either.
const savedImages: string[] = [];
mock.module("./images", () => ({
  saveBase64ImageToStorage: async (
    base64OrDataUrl: string | null | undefined,
    id: string
  ) => {
    if (!base64OrDataUrl) return null;
    savedImages.push(id);
    return `/storage/${id}`;
  },
}));

const { parsePdfFileAsMarkdownMistral } = await import("./mistral-ocr");

const CONTEXT = { tenantId: "00000000-0000-0000-0000-000000000000" };

const pdf = () =>
  new File([new Uint8Array([1, 2, 3])], "t.pdf", { type: "application/pdf" });

/**
 * Fake the three Mistral endpoints the parser talks to (upload, signed URL,
 * OCR) plus the cleanup DELETE. `withBase64` mirrors the real API: detected
 * images are always listed, but their `image_base64` is null unless the
 * request asked for the payloads.
 */
const originalFetch = globalThis.fetch;
let lastOcrBody: any = null;

const installFetchMock = (withBase64: boolean) => {
  lastOcrBody = null;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("/files") && init?.method === "POST") {
      return Response.json({ id: "file-1" });
    }
    if (url.includes("/files/file-1/url")) {
      return Response.json({ url: "https://signed.example/file-1" });
    }
    if (url.endsWith("/ocr")) {
      lastOcrBody = JSON.parse(init?.body as string);
      return Response.json({
        pages: [
          {
            markdown: "page one ![img-0.jpeg](img-0.jpeg)",
            images: [{ id: "img-0.jpeg", image_base64: withBase64 ? "AAAA" : null }],
          },
          { markdown: "page two" },
        ],
      });
    }
    if (init?.method === "DELETE") {
      return Response.json({ deleted: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  savedImages.length = 0;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("Mistral OCR parser", () => {
  test("extracts images and rewrites their markdown references", async () => {
    installFetchMock(true);

    const result = await parsePdfFileAsMarkdownMistral(pdf(), CONTEXT, {
      extractImages: true,
    });

    expect(lastOcrBody.include_image_base64).toBe(true);
    expect(savedImages).toEqual(["img-0.jpeg"]);
    expect(result.includesImages).toBe(true);
    expect(result.pages?.[0].text).toBe(
      "page one ![img-0.jpeg](/storage/img-0.jpeg)"
    );
    expect(result.pages?.map((p) => p.page)).toEqual([1, 2]);
  });

  test("does not crash when image extraction is off and image_base64 is null", async () => {
    installFetchMock(false);

    const result = await parsePdfFileAsMarkdownMistral(pdf(), CONTEXT, {
      extractImages: false,
    });

    expect(lastOcrBody.include_image_base64).toBe(false);
    expect(savedImages).toEqual([]);
    expect(result.includesImages).toBe(false);
    expect(result.pages?.[0].text).toBe("page one ![img-0.jpeg](img-0.jpeg)");
    expect(result.pages?.length).toBe(2);
  });
});
