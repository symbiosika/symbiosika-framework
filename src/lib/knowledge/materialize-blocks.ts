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

/**
 * Minimal structural view of a DOM element. Typed structurally because the
 * strict consumer build has no DOM lib, and because the implementation behind
 * Turndown differs by runtime (domino on the server, the test DOM in the
 * frontend suite) — only what is used here is assumed.
 */
type ElementLike = {
  nodeName: string;
  innerHTML: string;
  outerHTML: string;
  nextSibling: unknown;
  children: ArrayLike<ElementLike>;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
  getAttribute(name: string): string | null;
};

const isCell = (node: ElementLike): boolean =>
  node.nodeName === "TH" || node.nodeName === "TD";

/**
 * One table cell as inline markdown, safe to put between pipes: a cell whose
 * content is a block (the editor wraps cell content in `<p>`) would otherwise
 * carry newlines into the row and break the table apart, and a literal pipe
 * would end the cell early.
 */
const tableCellText = (
  service: TurndownService,
  cell: ElementLike
): string =>
  service
    .turndown(cell.innerHTML)
    .replace(/\|/g, "\\|")
    .replace(/\s*\n+\s*/g, " ")
    .trim();

/**
 * Render ANY table as a GFM table.
 *
 * turndown-plugin-gfm only converts a table whose first row it recognizes as a
 * heading row, and keeps every other table as raw html — which is how editor
 * tables used to end up as markup inside the page text (breaking search,
 * embedding, reading and export for everything in them). Two shapes miss its
 * check: a `<colgroup>` before the `<tbody>` (TipTap emits one for resizable
 * tables, so this is EVERY table saved in the editor) and a table without a
 * `<th>` row at all.
 *
 * GFM has no headerless table, so one is rendered with an empty header row:
 * that keeps every data row readable, where relabelling the first row as the
 * header would quietly turn data into a heading.
 */
const renderTable = (
  service: TurndownService,
  table: ElementLike
): string => {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return "";

  const cellsOf = (row: ElementLike): ElementLike[] =>
    Array.from(row.children).filter(isCell);
  const width = Math.max(...rows.map((row) => cellsOf(row).length));
  if (width === 0) return "";

  const line = (cells: string[]): string => {
    const padded = [...cells];
    while (padded.length < width) padded.push("");
    return `| ${padded.join(" | ")} |`;
  };
  const textOf = (row: ElementLike): string[] =>
    cellsOf(row).map((cell) => tableCellText(service, cell));
  const delimiter = `| ${Array(width).fill("---").join(" | ")} |`;

  const [first, ...rest] = rows as [ElementLike, ...ElementLike[]];
  const hasHeader = cellsOf(first).every((cell) => cell.nodeName === "TH");
  const lines = hasHeader
    ? [line(textOf(first)), delimiter, ...rest.map((row) => line(textOf(row)))]
    : [line([]), delimiter, ...rows.map((row) => line(textOf(row)))];

  return `\n\n${lines.join("\n")}\n\n`;
};

let turndown: TurndownService | null = null;
const getTurndown = (): TurndownService => {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    turndown.use(gfm);
    // Rules added here win over the gfm plugin's: `addRule` puts a rule at the
    // front of the list `forNode` walks, and that list is consulted before the
    // plugin's `keep` (which is what used to preserve tables as raw html).
    const service = turndown;
    turndown.addRule("anyTable", {
      filter: (node) => node.nodeName === "TABLE",
      replacement: (_content, node) =>
        renderTable(service, node as unknown as ElementLike),
    });
    // A task item's checked state is content, not decoration: without these two
    // rules a checklist reads as a plain bullet list, so neither a reader nor an
    // agent can tell done from open. The gfm plugin has a rule for the checkbox
    // but expects it to sit directly in the `<li>`; the editor wraps it in a
    // `<label>` and the item's text in a `<div>`, so it never fires — and the
    // `<div>` would push the text onto its own line even if it did.
    turndown.addRule("taskListItem", {
      filter: (node) =>
        node.nodeName === "LI" &&
        (node as unknown as ElementLike).getAttribute("data-type") ===
          "taskItem",
      replacement: (_content, node, options) => {
        const item = node as unknown as ElementLike;
        // everything but the checkbox label is the item's content, rendered on
        // its own so nested lists keep working
        const body = Array.from(item.children)
          .filter((child) => child.nodeName !== "LABEL")
          .map((child) => child.outerHTML)
          .join("");
        const rendered = service
          .turndown(body)
          .replace(/^\n+/, "")
          .replace(/\n+$/, "\n")
          // indent continuation lines the way Turndown's own list item does
          .replace(/\n/gm, "\n    ");
        const marker = item.getAttribute("data-checked") === "true" ? "x" : " ";
        const prefix = `${options.bulletListMarker}   [${marker}] `;
        return (
          prefix +
          rendered +
          (item.nextSibling && !/\n$/.test(rendered) ? "\n" : "")
        );
      },
    });
    // Fallback for the shape a markdown task list renders to (`<li><input
    // type="checkbox"> text</li>`), where the checkbox is inline in the item.
    // No trailing space: the marker is inline, so the separator already comes
    // from the item's own text.
    turndown.addRule("taskListItemCheckbox", {
      filter: (node) =>
        node.nodeName === "INPUT" &&
        (node as unknown as ElementLike).getAttribute("type") === "checkbox",
      replacement: (_content, node) =>
        (node as unknown as ElementLike).getAttribute("checked") !== null
          ? "[x]"
          : "[ ]",
    });
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
