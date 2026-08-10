/**
 * Pure assembly of a block-mode page's materialized `text` from its blocks.
 *
 * Kept free of DB / side-effecting imports so it can be unit-tested and reused
 * by both the block-save path (`knowledge-text-blocks.ts`) and the embedding
 * sync (which needs the per-block character spans to attach chunk provenance).
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { unescapeWikiLinkMarkers, wikiLinkMarker } from "./wikilinks";

/** Join separator between materialized blocks. */
export const BLOCK_SEPARATOR = "\n\n";

export type MaterializeBlock = {
  id?: string;
  type: "markdown" | "html";
  content: string;
};

let turndown: TurndownService | null = null;
const getTurndown = (): TurndownService => {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    turndown.use(gfm);
    // A page reference is stored as <code data-wiki-link="Target">[[Target]]</code>
    // (see wikilinks.ts). Emit the bare marker instead of Turndown's default
    // `` `[[Target]]` `` so the cache reads like hand-written markdown.
    turndown.addRule("wikiLink", {
      filter: (node) =>
        node.nodeName === "CODE" && node.getAttribute("data-wiki-link") !== null,
      replacement: (content, node) => {
        // typed structurally: the strict consumer build has no DOM lib
        const element = node as unknown as {
          getAttribute(name: string): string | null;
        };
        const target = element.getAttribute("data-wiki-link") ?? "";
        if (!target) return content;
        return wikiLinkMarker(target, element.getAttribute("data-wiki-alias"));
      },
    });
  }
  return turndown;
};

/**
 * One block's rendered markdown text (html → markdown), trimmed. This is the
 * PROJECTION an API/MCP reader sees of a block — exported because the edit path
 * matches against it when the stored html cannot carry a match itself.
 *
 * Turndown escapes square brackets (`[[X]]` → `\[\[X\]\]`), which would hide a
 * page reference from the link extraction and show the backslashes to anyone
 * reading the page through the API — so wikilink markers are restored.
 */
export const renderBlockText = (
  block: Pick<MaterializeBlock, "type" | "content">
): string =>
  block.type === "html"
    ? unescapeWikiLinkMarkers(getTurndown().turndown(block.content)).trim()
    : block.content.trim();

/**
 * Assemble the page's materialized `text` from its blocks. HTML blocks are
 * converted to markdown so the cache stays homogeneous for search/embedding.
 */
export const materializeBlocksText = (
  blocks: Pick<MaterializeBlock, "type" | "content">[]
): string => materializeBlocksTextWithSpans(blocks).text;

/** Half-open character range of one block inside the materialized text. */
export type MaterializedBlockSpan = {
  blockId: string;
  start: number;
  end: number;
};

/**
 * Like {@link materializeBlocksText}, but also returns the character span each
 * block occupies in the produced text. Only blocks that carry an `id` and
 * render to non-empty text get a span (empty blocks are dropped from the text,
 * exactly as in `materializeBlocksText`, so the two outputs stay identical).
 *
 * Used by the embedding sync to map chunks back to their source block without
 * changing how the text itself is assembled.
 */
export const materializeBlocksTextWithSpans = (
  blocks: Pick<MaterializeBlock, "id" | "type" | "content">[]
): { text: string; spans: MaterializedBlockSpan[] } => {
  const spans: MaterializedBlockSpan[] = [];
  const parts: string[] = [];
  let offset = 0;

  for (const block of blocks) {
    const part = renderBlockText(block);
    if (part.length === 0) continue;

    if (parts.length > 0) offset += BLOCK_SEPARATOR.length;
    const start = offset;
    offset += part.length;
    parts.push(part);

    if (block.id) spans.push({ blockId: block.id, start, end: offset });
  }

  return { text: parts.join(BLOCK_SEPARATOR), spans };
};
