/**
 * Per-image descriptions — one shared representation.
 *
 * An image on a wiki page is a dead end for anything that only reads text: an
 * AI client, the full-text index, the embedding of a chunk. All three see
 * `![name.png](/files/db/knowledge/<uuid>.png)` — a path, and at best a file
 * name as the alt text. The picture itself carries the knowledge.
 *
 * A description closes that gap. Like a wikilink (see ./wikilinks.ts) it lives
 * in three places at once and must mean the same thing in all of them:
 *
 *   - **html blocks** — the block editor stores it on the image itself,
 *     `<img src="…" data-description="…">`, and renders it as a collapsed
 *     caption. This is the source of truth a human edits.
 *   - **markdown / plain text** — the marker
 *     `<image-description src="…">…</image-description>` on its own line,
 *     directly below the image it belongs to. This is what an agent writes
 *     through the API/MCP tools, and what a parsing service emits for an
 *     imported document.
 *   - **the materialized `text` cache** — assembled from the blocks, so the
 *     marker is what the full-text index, the chunker and every text reader
 *     get to see. That is the whole point: a description that is not in the
 *     text is not searchable and not embedded.
 *
 * Two deliberate constraints keep those three in sync:
 *
 *   1. **Single line.** A description is normalized to one line
 *      (`normalizeImageDescription`) before it is stored anywhere. It has to
 *      survive as an html attribute, as one markdown line, and inside a chunk
 *      that may be cut at any blank line — a multi-paragraph caption would
 *      round-trip differently in each of them.
 *   2. **The `src` is part of the marker.** A chunk can start below the image
 *      the description belongs to, so positional association alone would lose
 *      it. With the path in the marker, an isolated chunk still says WHICH
 *      image is being described.
 */

/**
 * The marker as it appears in markdown/plain text. Tolerant on purpose:
 * attributes in any order (agents write this by hand), a self-closed or
 * loosely spaced closing tag, and any content in between — but never across
 * another marker, so two adjacent images stay separate.
 */
export const IMAGE_DESCRIPTION_PATTERN =
  /<image-description\b([^>]*)>([\s\S]*?)<\/image-description\s*>/gi;

/** `src="…"` or `src='…'` inside the marker's attribute list. */
const SRC_ATTRIBUTE_PATTERN = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** The attribute the block editor stores a description in. */
export const IMAGE_DESCRIPTION_ATTRIBUTE = "data-description";

const escapeHtmlText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeHtmlAttribute = (value: string): string =>
  escapeHtmlText(value).replace(/"/g, "&quot;");

/**
 * Undo the escaping above. Only the five entities this module produces plus
 * the two spellings of an apostrophe — deliberately not a general html
 * decoder: a description is text, and anything else in it should stay verbatim
 * rather than be reinterpreted on every round trip.
 */
const decodeHtmlText = (value: string): string =>
  value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;|&#160;/gi, " ")
    // last, so a literal "&amp;lt;" does not become "<"
    .replace(/&amp;/gi, "&");

/**
 * One line, no leading/trailing space, no empty string.
 *
 * Every whitespace run — newlines included — collapses to a single space: see
 * constraint 1 above. Returns `null` for anything that carries no text, so
 * "no description" has exactly one representation everywhere.
 */
export const normalizeImageDescription = (
  value: string | null | undefined
): string | null => {
  if (!value) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : null;
};

/** Build the marker for one image. Returns "" when there is nothing to say. */
export const imageDescriptionMarker = (
  src: string,
  description: string | null | undefined
): string => {
  const text = normalizeImageDescription(description);
  if (!text) return "";
  return (
    `<image-description src="${escapeHtmlAttribute(src)}">` +
    `${escapeHtmlText(text)}</image-description>`
  );
};

/** True when the content carries at least one marker. */
export const containsImageDescription = (content: string): boolean =>
  /<image-description\b/i.test(content);

/**
 * The descriptions in a piece of content, keyed by the image path they
 * describe. A marker without a `src`, or with an empty description, is
 * skipped; a repeated `src` keeps the first description (the one closest to
 * the top, which is the one next to the image).
 */
export const extractImageDescriptions = (
  content: string
): Record<string, string> => {
  const found: Record<string, string> = {};
  if (!containsImageDescription(content)) return found;

  for (const match of content.matchAll(IMAGE_DESCRIPTION_PATTERN)) {
    const src = SRC_ATTRIBUTE_PATTERN.exec(match[1] ?? "");
    const path = decodeHtmlText(src?.[1] ?? src?.[2] ?? "").trim();
    if (!path || found[path] !== undefined) continue;
    const description = normalizeImageDescription(
      decodeHtmlText(match[2] ?? "")
    );
    if (description) found[path] = description;
  }
  return found;
};

/**
 * Remove every marker from a piece of content, leaving no blank line behind
 * where one sat alone.
 *
 * For consumers that render the text for a HUMAN and show the description
 * their own way (a caption, a tooltip, an expander) — the marker is machine
 * surface, not something anyone should read as markup.
 */
export const stripImageDescriptions = (content: string): string => {
  if (!containsImageDescription(content)) return content;
  return content
    // the marker alone on its line: take the line with it
    .replace(
      new RegExp(
        `^[^\\S\\n]*${IMAGE_DESCRIPTION_PATTERN.source}[^\\S\\n]*\\n?`,
        "gim"
      ),
      ""
    )
    // any remaining (inline) marker
    .replace(IMAGE_DESCRIPTION_PATTERN, "");
};
