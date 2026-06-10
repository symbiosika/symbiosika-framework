/**
 * Fetch an HTML document from a URL and convert it to clean markdown.
 *
 * Pipeline:
 *   1. fetch() → HTML string (with a polite User-Agent)
 *   2. linkedom → DOM
 *   3. Mozilla Readability → article (title, excerpt, byline, content HTML)
 *   4. Turndown + GFM (tables, strikethrough, task lists) → markdown
 *
 * If Readability cannot extract anything (e.g. SPA with empty <body>),
 * the entire body innerHTML is converted as fallback.
 */

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import log from "../../log";
import { fetchWithSsrfGuard } from "../../utils/url-guard";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; SymbiosikaKnowledgeBot/1.0; +https://symbiosika.de)";
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type UrlToMarkdownOptions = {
  userAgent?: string;
  timeoutMs?: number;
};

export type UrlToMarkdownResult = {
  url: string;
  title: string;
  excerpt: string | null;
  byline: string | null;
  siteName: string | null;
  markdown: string;
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
    return html.replace(
      /<html([^>]*)>/i,
      `<html$1><head>${baseTag}</head>`
    );
  }
  return `<head>${baseTag}</head>${html}`;
};

const fetchHtml = async (url: string, opts?: UrlToMarkdownOptions) => {
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
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml") &&
      !contentType.includes("application/xml")
    ) {
      log.debug(
        `URL ${url} returned non-HTML content-type "${contentType}". Trying to parse anyway.`
      );
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Convert the HTML page at `url` into clean markdown using Readability + Turndown.
 */
export const urlToMarkdown = async (
  url: string,
  opts?: UrlToMarkdownOptions
): Promise<UrlToMarkdownResult> => {
  const html = await fetchHtml(url, opts);

  // Inject <base href> so Readability can resolve relative links/images.
  const htmlWithBase = injectBaseHref(html, url);
  const { document } = parseHTML(htmlWithBase);

  // Readability mutates the document; clone first so we still have a fallback body.
  const docClone = document.cloneNode(true) as unknown as typeof document;
  const article = new Readability(docClone as any).parse();

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
    (article?.title && article.title.trim()) ||
    document.title?.trim() ||
    url;

  return {
    url,
    title,
    excerpt: article?.excerpt?.trim() || null,
    byline: article?.byline?.trim() || null,
    siteName: article?.siteName?.trim() || null,
    markdown,
  };
};
