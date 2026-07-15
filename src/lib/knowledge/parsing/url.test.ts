import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { urlToMarkdown } from "./url";

// A local test server serves the fixtures; allow the SSRF guard to reach it.
let savedOptOut: string | undefined;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  savedOptOut = process.env.SSRF_ALLOW_PRIVATE_TARGETS;
  process.env.SSRF_ALLOW_PRIVATE_TARGETS = "true";

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);

      if (pathname === "/doc.pdf") {
        // Minimal PDF bytes: "%PDF-" magic + a little padding.
        const bytes = new TextEncoder().encode("%PDF-1.4\n%noise\n");
        return new Response(bytes, {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="doc.pdf"',
          },
        });
      }

      if (pathname === "/image.png") {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
        return new Response(bytes, {
          headers: { "content-type": "image/png" },
        });
      }

      if (pathname === "/page.html") {
        return new Response(
          `<!doctype html><html><head><title>Hello Page</title></head>` +
            `<body><article><h1>Heading</h1><p>Some readable paragraph of text ` +
            `that is long enough for Readability to keep it around as content.</p>` +
            `</article></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  if (savedOptOut !== undefined) {
    process.env.SSRF_ALLOW_PRIVATE_TARGETS = savedOptOut;
  } else {
    delete process.env.SSRF_ALLOW_PRIVATE_TARGETS;
  }
});

describe("urlToMarkdown", () => {
  it("routes PDF downloads to the PDF parser (no Readability tagName crash)", async () => {
    // With a parseContext the PDF path is taken. There is no PDF parser service
    // configured in tests, so it fails with a clear PDF-parser message — crucially
    // NOT the Readability `tagName` crash and NOT silent binary garbage.
    let err: unknown;
    try {
      await urlToMarkdown(`${baseUrl}/doc.pdf`, {
        parseContext: { tenantId: "test-tenant" },
        pdfModel: "does-not-exist",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).not.toContain("tagName");
    expect(msg).toContain("PDF parser service");
  });

  it("rejects a PDF URL when no parseContext is provided", async () => {
    await expect(urlToMarkdown(`${baseUrl}/doc.pdf`)).rejects.toThrow(
      /no parseContext/i
    );
  });

  it("rejects unsupported binary content types instead of crashing", async () => {
    let err: unknown;
    try {
      await urlToMarkdown(`${baseUrl}/image.png`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).not.toContain("tagName");
    expect(msg).toContain("Unsupported content type");
  });

  it("converts a normal HTML page to markdown (regression)", async () => {
    const result = await urlToMarkdown(`${baseUrl}/page.html`);
    expect(result.title).toBe("Hello Page");
    expect(result.markdown).toContain("Heading");
    expect(result.markdown).toContain("readable paragraph");
  });
});
