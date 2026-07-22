/**
 * Fetch a document from a URL and convert it to clean markdown.
 *
 * Pipeline (HTML path):
 *   1. fetch() → raw bytes + content-type (with a polite User-Agent)
 *   2. linkedom → DOM
 *   3. Mozilla Readability → article (title, excerpt, byline, content HTML)
 *   4. Turndown + GFM (tables, strikethrough, task lists) → markdown
 *
 * If Readability cannot extract anything (e.g. SPA with empty <body>),
 * the entire body innerHTML is converted as fallback.
 *
 * Not every import URL is an HTML page. Many are file downloads (e.g. WP
 * Download Manager `?wpdmdl=…`) that respond with `Content-Type:
 * application/pdf`. Feeding raw PDF bytes through Readability either crashes
 * (the mis-parsed byte soup has no <body>, so Readability walks the parent
 * chain up to `null.tagName`) or stores megabytes of binary noise as "text".
 * We therefore branch on the content type first: PDFs go to the dedicated PDF
 * parser, other binary formats are rejected with a clear error, and only
 * textual responses reach the HTML pipeline.
 */

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import log from "../../log";
import { fetchWithSsrfGuard } from "../../utils/url-guard";
import { parsePdfFileAsMardown } from "./pdf";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; SymbiosikaKnowledgeBot/1.0; +https://symbiosika.de)";
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type UrlToMarkdownOptions = {
  userAgent?: string;
  timeoutMs?: number;
  /**
   * Required to import PDF downloads: the PDF parser needs a tenant context.
   * Without it, PDF URLs are rejected with a clear error instead of crashing.
   */
  parseContext?: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
  };
  /** Override the PDF parser service/model (falls back to PDF_PARSER_SERVICE). */
  pdfModel?: string;
};

export type UrlToMarkdownResult = {
  url: string;
  title: string;
  excerpt: string | null;
  byline: string | null;
  siteName: string | null;
  markdown: string;
};

type FetchedResource = {
  contentType: string;
  disposition: string;
  bytes: Uint8Array;
};

/**
 * linkedom (unlike JSDOM) does not accept a document URL, so relative URLs in
 * the parsed HTML have no base to resolve against. We inject a <base href>
 * into <head> so Readability and downstream consumers see absolute links.
 */
const injectBaseHref = (html: string, url: string): string => {
  if (/<base\s[^>]*href=/i.test(html)) return html;
  const baseTag = `<base href="${url.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
  }
  return `<head>${baseTag}</head>${html}`;
};

/**
 * Fetch the resource at `url`, returning the raw bytes together with the
 * content-type and content-disposition headers. We read `arrayBuffer()` (not
 * `text()`) so binary payloads such as PDFs stay intact.
 */
const fetchHtml = async (
  url: string,
  opts?: UrlToMarkdownOptions
): Promise<FetchedResource> => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  );
  try {
    // SSRF guard: validate the URL (and every redirect hop) so a user-supplied
    // URL cannot reach internal services or the cloud metadata endpoint.
    const response = await fetchWithSsrfGuard(url, {
      headers: {
        "User-Agent": opts?.userAgent ?? DEFAULT_USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en;q=0.9,de;q=0.8",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch URL ${url}: ${response.status} ${response.statusText}`
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    const disposition = response.headers.get("content-disposition") ?? "";
    const bytes = new Uint8Array(await response.arrayBuffer());

    return { contentType, disposition, bytes };
  } finally {
    clearTimeout(timeout);
  }
};

/** PDF magic bytes: "%PDF-" == 25 50 44 46 2d */
const hasPdfMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d;

/** Detect PDFs by content-type, filename in content-disposition, or magic bytes. */
const isPdf = (
  contentType: string,
  disposition: string,
  bytes: Uint8Array
): boolean =>
  contentType.toLowerCase().includes("application/pdf") ||
  /filename[^;=\n]*=\s*["']?[^"';\n]*\.pdf/i.test(disposition) ||
  hasPdfMagic(bytes);

/**
 * A response is safe to run through the HTML pipeline if it is HTML/XHTML/XML
 * or plain text (or the server sent no content-type at all).
 */
const isTextual = (contentType: string): boolean => {
  const ct = contentType.toLowerCase();
  return (
    ct === "" ||
    ct.includes("text/html") ||
    ct.includes("application/xhtml") ||
    ct.includes("xml") ||
    ct.includes("text/plain")
  );
};

/** Extract the charset from a content-type header (defaults handled by caller). */
const charsetFrom = (contentType: string): string | null => {
  const m = /charset=([^;]+)/i.exec(contentType);
  return m?.[1] ? m[1].trim().replace(/^["']|["']$/g, "") : null;
};

/** Derive a filename (ending in .pdf) from content-disposition or the URL. */
const filenameFrom = (disposition: string, url: string): string => {
  const dispMatch =
    /filename\*=(?:UTF-8'')?["']?([^"';\n]+)/i.exec(disposition) ??
    /filename\s*=\s*["']?([^"';\n]+)/i.exec(disposition);
  let name = dispMatch?.[1]?.trim();

  if (!name) {
    try {
      const pathname = new URL(url).pathname;
      const last = pathname.split("/").filter(Boolean).pop();
      if (last) name = decodeURIComponent(last);
    } catch {
      // ignore malformed URL; fall through to default
    }
  }

  if (!name) name = "download";
  if (!/\.pdf$/i.test(name)) name = `${name}.pdf`;
  return name;
};

/** Human-friendly title from a filename (strip .pdf, keep the base name). */
const titleFrom = (name: string): string =>
  name.replace(/\.pdf$/i, "").trim() || name;

/**
 * Convert the document at `url` into clean markdown.
 * HTML pages use Readability + Turndown; PDF downloads use the PDF parser.
 */
export const urlToMarkdown = async (
  url: string,
  opts?: UrlToMarkdownOptions
): Promise<UrlToMarkdownResult> => {
  const { contentType, disposition, bytes } = await fetchHtml(url, opts);

  // PDF downloads: route to the dedicated PDF parser instead of Readability.
  if (isPdf(contentType, disposition, bytes)) {
    if (!opts?.parseContext) {
      throw new Error(
        `Cannot import PDF ${url}: no parseContext (tenantId) provided.`
      );
    }
    const name = filenameFrom(disposition, url);
    const file = new File(
      [bytes as ConstructorParameters<typeof File>[0][number]],
      name,
      {
        type: "application/pdf",
      }
    );
    const parsed = await parsePdfFileAsMardown(file, opts.parseContext, {
      model: opts.pdfModel,
    });
    const markdown = (parsed.pages?.map((p) => p.text).join("\n\n") ?? "").trim();
    if (!markdown) {
      throw new Error(`PDF at ${url} produced no extractable text.`);
    }
    return {
      url,
      title: titleFrom(name),
      excerpt: null,
      byline: null,
      siteName: null,
      markdown,
    };
  }

  // Reject other binary formats rather than feeding them to Readability.
  if (!isTextual(contentType)) {
    throw new Error(
      `Unsupported content type "${contentType}" for URL import ${url}.`
    );
  }

  const html = new TextDecoder(
    (charsetFrom(contentType) ?? "utf-8") as ConstructorParameters<
      typeof TextDecoder
    >[0]
  ).decode(bytes);

  // Inject <base href> so Readability can resolve relative links/images.
  const htmlWithBase = injectBaseHref(html, url);
  const { document } = parseHTML(htmlWithBase);

  // Readability mutates the document; clone first so we still have a fallback body.
  const docClone = document.cloneNode(true) as unknown as typeof document;
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(docClone as any).parse();
  } catch (e) {
    log.debug(`Readability failed for ${url}, using body fallback: ${e}`);
  }

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  td.use(gfm);

  const fallbackHtml = document.body?.innerHTML ?? html;
  const sourceHtml =
    article?.content && article.content.length > 0
      ? article.content
      : fallbackHtml;

  const markdown = td.turndown(sourceHtml).trim();

  const title =
    (article?.title && article.title.trim()) || document.title?.trim() || url;

  return {
    url,
    title,
    excerpt: article?.excerpt?.trim() || null,
    byline: article?.byline?.trim() || null,
    siteName: article?.siteName?.trim() || null,
    markdown,
  };
};
