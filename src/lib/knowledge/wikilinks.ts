/**
 * Obsidian-style `[[wikilink]]` markers — one shared representation.
 *
 * A page reference is written as `[[Target Title]]` (or `[[Target|shown text]]`)
 * and lives in three places at once:
 *
 *   - **markdown / plain text** — the marker verbatim; this is what
 *     `extractPageLinkTargets` (knowledge-text-links.ts) scans for and what
 *     agents write through the API and MCP tools
 *   - **html blocks** — the block editor stores a reference as
 *     `<code data-wiki-link="Target">[[Target]]</code>`, which it renders as a
 *     clickable chip. Plain `[[Target]]` text inside an html block is just text
 *     to the editor, so writes coming from an agent are lifted into that
 *     canonical form (`wikiLinksToHtml`)
 *   - **the materialized `text` cache** — assembled from the blocks by running
 *     html through Turndown, which escapes square brackets
 *     (`[[X]]` → `\[\[X\]\]`) and would break the extraction; markers are
 *     restored afterwards (`unescapeWikiLinkMarkers`)
 *
 * Keeping the pattern and the conversions here means the write path (agent
 * edits), the read path (materialization) and the link extraction can never
 * disagree about what a reference looks like.
 */

/** `[[Target]]` or `[[Target|alias]]` — target must not contain `[`, `]` or `|` */
export const PAGE_LINK_PATTERN = /\[\[([^\[\]|]+)(?:\|([^\[\]]*))?\]\]/g;

/**
 * The same marker after Turndown escaped it: `\[\[Target\]\]`. The alias pipe
 * may be escaped too (Turndown escapes `|` in some contexts).
 */
const ESCAPED_PAGE_LINK_PATTERN =
  /\\\[\\\[([^\[\]|]+?)(?:\\?\|([^\[\]]*?))?\\\]\\\]/g;

/** Either form of the marker; stateless (no `g`), so `.test` is safe to reuse. */
const ANY_MARKER_PATTERN = new RegExp(
  `${PAGE_LINK_PATTERN.source}|${ESCAPED_PAGE_LINK_PATTERN.source}`
);

/** True when the string contains at least one marker, plain or escaped. */
export const containsWikiLinkMarker = (text: string): boolean =>
  ANY_MARKER_PATTERN.test(text);

/** Build the raw `[[Target]]` / `[[Target|alias]]` marker. */
export const wikiLinkMarker = (target: string, alias?: string | null): string =>
  alias ? `[[${target}|${alias}]]` : `[[${target}]]`;

const escapeHtmlText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeHtmlAttribute = (value: string): string =>
  escapeHtmlText(value).replace(/"/g, "&quot;");

/**
 * The canonical html of a reference — identical in shape to what the block
 * editor's wikiLink node serializes, so a link written by an agent and one
 * inserted by a human are stored the same way (and render as the same chip).
 */
export const wikiLinkHtml = (target: string, alias?: string | null): string =>
  `<code data-wiki-link="${escapeHtmlAttribute(target)}"` +
  (alias ? ` data-wiki-alias="${escapeHtmlAttribute(alias)}"` : "") +
  ` class="wiki-link">${escapeHtmlText(wikiLinkMarker(target, alias))}</code>`;

/** Regions of an html string whose text must stay verbatim. */
const VERBATIM_REGION_PATTERN =
  /<code\b[^>]*>[\s\S]*?<\/code>|<pre\b[^>]*>[\s\S]*?<\/pre>|<[^>]+>/gi;

const markersToHtml = (text: string): string =>
  // an escaped marker (`\[\[X\]\]`, e.g. read back from an older, escaped text
  // cache and written again) is healed into a real reference on the way in
  unescapeWikiLinkMarkers(text).replace(
    PAGE_LINK_PATTERN,
    (match, target: string, alias?: string) => {
      const trimmed = target.trim();
      if (!trimmed) return match;
      return wikiLinkHtml(trimmed, alias?.trim() || null);
    }
  );

/**
 * Lift plain `[[Target]]` markers in an html fragment into the canonical
 * `<code data-wiki-link>` form (escaped `\[\[Target\]\]` markers are healed on
 * the way). Existing wikilink elements, code blocks and
 * anything inside a tag (attribute values) are left untouched, so calling this
 * repeatedly is a no-op after the first pass.
 */
export const wikiLinksToHtml = (html: string): string => {
  if (!containsWikiLinkMarker(html)) return html;

  let result = "";
  let index = 0;
  for (const region of html.matchAll(VERBATIM_REGION_PATTERN)) {
    const start = region.index ?? 0;
    result += markersToHtml(html.slice(index, start)) + region[0];
    index = start + region[0].length;
  }
  return result + markersToHtml(html.slice(index));
};

/**
 * Undo Turndown's bracket escaping for wikilink markers, so the materialized
 * text of an html block carries real `[[Target]]` markers again.
 */
export const unescapeWikiLinkMarkers = (markdown: string): string =>
  markdown.replace(
    ESCAPED_PAGE_LINK_PATTERN,
    (_match, target: string, alias?: string) =>
      wikiLinkMarker(target, alias ?? null),
  );
