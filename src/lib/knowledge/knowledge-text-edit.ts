/**
 * Filesystem-like content access for knowledgeText pages, designed for AI
 * agents that work with pages the way coding agents work with files:
 *
 *   - `readKnowledgeTextContent` — read the page text, optionally a line
 *     range (like `Read` with offset/limit), with line-count metadata so
 *     the agent can page through long documents
 *   - `editKnowledgeTextContent` — exact string replacement (like `Edit`
 *     with old_string/new_string/replaceAll), applied safely to both plain
 *     text pages and block pages
 *
 * Edits on block pages are applied inside the affected block(s), then run
 * through the normal block sync, so text cache, history, page links and the
 * embedding mirror all stay consistent. A replacement that empties a block
 * drops it instead of leaving an empty placeholder block behind, and a
 * deletion (empty `newString`) whose `oldString` spans several blocks removes
 * the covered blocks in one go — the clean "remove multiple blocks at once".
 *
 * The hard part of a block page is that the agent reads a PROJECTION (the
 * materialized markdown) of what it writes to (the stored html). Two rules keep
 * that honest:
 *
 *   - matching inside an html block tolerates exactly the differences the
 *     round trip introduces — a reference stored as a `<code data-wiki-link>`
 *     element with whatever attributes the editor added, entity-encoded
 *     characters, collapsed whitespace (`wikiLinkTolerantHtmlPattern`)
 *   - before anything is persisted, the edited blocks are materialized and
 *     compared against the expected text (`assertRoundTrips`). An edit the
 *     block format cannot carry fails loudly instead of leaving mangled
 *     fragments behind.
 */

import {
  getKnowledgeTextById,
  updateKnowledgeText,
} from "./knowledge-texts";
import {
  getKnowledgeTextBlocks,
  syncKnowledgeTextBlocks,
  type KnowledgeTextBlockInput,
} from "./knowledge-text-blocks";
import {
  materializeBlocksText,
  materializeBlocksTextWithSpans,
} from "./materialize-blocks";
import { wikiLinksToHtml, wikiLinkTolerantHtmlPattern } from "./wikilinks";
import type { KnowledgeTextBlockSelect } from "../db/schema/knowledge";

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

export type KnowledgeTextContentView = {
  id: string;
  title: string;
  contentMode: "text" | "blocks";
  /** requested slice of the content */
  content: string;
  /** 1-based line number of the first returned line */
  fromLine: number;
  /** 1-based line number of the last returned line */
  toLine: number;
  totalLines: number;
};

/**
 * Read a page's content, optionally restricted to a line range.
 * `fromLine` is 1-based; `maxLines` limits how many lines are returned.
 */
export const readKnowledgeTextContent = async (
  id: string,
  context: Context,
  options?: { fromLine?: number; maxLines?: number }
): Promise<KnowledgeTextContentView> => {
  const page = await getKnowledgeTextById(id, context);
  const lines = page.text.split("\n");
  const totalLines = lines.length;

  const fromLine = Math.max(1, options?.fromLine ?? 1);
  const maxLines = options?.maxLines ?? totalLines;
  if (options?.fromLine !== undefined && fromLine > totalLines) {
    throw new Error(
      `fromLine ${fromLine} is beyond the end of the document (${totalLines} lines)`
    );
  }
  const slice = lines.slice(fromLine - 1, fromLine - 1 + Math.max(0, maxLines));

  return {
    id: page.id,
    title: page.title,
    contentMode: page.contentMode,
    content: slice.join("\n"),
    fromLine,
    toLine: fromLine + Math.max(0, slice.length - 1),
    totalLines,
  };
};

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
};

const replaceAllOccurrences = (
  haystack: string,
  needle: string,
  replacement: string
): string => haystack.split(needle).join(replacement);

/**
 * Wikilinks written into an html block ("[[Target]]") are stored in the
 * editor's canonical `<code data-wiki-link>` form, so a reference an agent
 * writes is a real, clickable page link — exactly like one inserted by hand.
 * Markdown blocks keep the plain marker (that IS their canonical form).
 */
const blockReplacement = (
  block: Pick<KnowledgeTextBlockSelect, "type">,
  newString: string
): string => (block.type === "html" ? wikiLinksToHtml(newString) : newString);

type BlockMatch = {
  /** how often `oldString` occurs in this block */
  count: number;
  /** the block's content with every occurrence replaced */
  replaced: (replacement: string) => string;
};

/**
 * Find `oldString` inside one block. An agent copies it out of the materialized
 * text, which for an html block is Turndown's rendering of the stored html — so
 * a literal search is only the fast path. When it misses, an html block is
 * searched with a pattern that tolerates exactly the differences that round
 * trip introduces: references stored as `<code data-wiki-link>` elements
 * (whatever attributes the editor put on them), entity-encoded characters and
 * collapsed whitespace. Markdown blocks store their text verbatim, so for them
 * the literal search is the whole story.
 */
const matchInBlock = (
  block: Pick<KnowledgeTextBlockSelect, "type" | "content">,
  oldString: string
): BlockMatch => {
  const literal = countOccurrences(block.content, oldString);
  if (literal > 0 || block.type !== "html") {
    return {
      count: literal,
      replaced: (replacement) =>
        replaceAllOccurrences(block.content, oldString, replacement),
    };
  }

  const pattern = wikiLinkTolerantHtmlPattern(oldString);
  return {
    count: block.content.match(pattern)?.length ?? 0,
    // a function replacement, so `$&` and friends in the replacement text are
    // inserted literally
    replaced: (replacement) =>
      block.content.replace(pattern, () => replacement),
  };
};

/** Message used when a cross-block match can't be resolved to a clean edit. */
const SPANS_BLOCKS_MESSAGE =
  "oldString spans multiple blocks and covers only part of a rich-text " +
  "block. Edit the blocks individually (PUT .../blocks), or use a string " +
  "that either stays within one block or covers whole blocks";

/**
 * Message for a replacement that cannot be represented inside a rich-text
 * (html) block: block structure — line breaks, lists, headings — has no
 * meaning as plain text there, and writing it raw is what used to leave
 * mangled fragments behind.
 */
const HTML_BLOCK_STRUCTURE_MESSAGE =
  "newString contains line breaks, which cannot be written into a rich-text " +
  "block as markdown. Replace text within one paragraph, append_to_page for " +
  "new paragraphs, or edit the blocks directly (PUT .../blocks)";

/**
 * Message for an edit whose result would not read back as it was written.
 * Raised BEFORE anything is persisted, so a replacement that the block format
 * cannot represent fails loudly instead of corrupting the page.
 */
const ROUND_TRIP_MESSAGE =
  "the edit could not be applied cleanly: the page would not read back as " +
  "written. Keep newString plain text (page references [[Title]] are fine) — " +
  "markdown formatting cannot be written into a rich-text block; use " +
  "PUT .../blocks for that";

/**
 * Whitespace is not compared: a deletion that empties or trims a block
 * legitimately turns spaces into block separators (and back), which says
 * nothing about whether the edit landed correctly. Everything that matters
 * here — dropped or duplicated text, markdown Turndown would escape — differs
 * in more than whitespace.
 */
const normalizeForRoundTrip = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

/**
 * Verify that applying the edit to the blocks really produces the text the
 * caller asked for: the edited blocks are materialized locally and compared
 * against the expected text (the page's current text with the replacement
 * applied). Because both sides are derived from the same blocks, only the
 * edited region can differ — so this catches a replacement the html format
 * cannot carry (markdown that Turndown would escape, structure that collapses)
 * while leaving legitimate edits alone.
 */
const assertRoundTrips = (
  currentText: string,
  edit: { oldString: string; newString: string; replaceAll: boolean },
  nextBlocks: KnowledgeTextBlockInput[]
): void => {
  const expected = edit.replaceAll
    ? replaceAllOccurrences(currentText, edit.oldString, edit.newString)
    : currentText.replace(edit.oldString, () => edit.newString);
  if (
    normalizeForRoundTrip(materializeBlocksText(nextBlocks)) !==
    normalizeForRoundTrip(expected)
  ) {
    throw new Error(ROUND_TRIP_MESSAGE);
  }
};

type WorkingBlock = {
  id: string;
  type: "markdown" | "html";
  content: string;
  meta: Record<string, unknown>;
};

const toWorkingBlock = (block: KnowledgeTextBlockSelect): WorkingBlock => ({
  id: block.id,
  type: block.type,
  content: block.content,
  meta: (block.meta ?? {}) as Record<string, unknown>,
});

/**
 * Delete every (or the first) occurrence of `oldString` from the materialized
 * text of a block page, mapping the removal back onto the underlying blocks:
 * blocks the match fully covers are emptied (and later dropped), boundary
 * blocks keep the part outside the match.
 *
 * A block the match covers COMPLETELY is dropped whatever its type — no
 * offsets need mapping for that, so removing a whole section (heading plus
 * list, however it is stored) works. Only a PARTIALLY covered html block is
 * refused (`SPANS_BLOCKS_MESSAGE`): its stored content differs from its
 * materialized markdown, so a boundary inside it has no unambiguous position.
 *
 * Returns the surviving block inputs (emptied blocks removed) and the number
 * of matches deleted.
 */
const deleteSpanningText = (
  blocks: KnowledgeTextBlockSelect[],
  oldString: string,
  replaceAll: boolean
): { inputs: KnowledgeTextBlockInput[]; replacements: number } => {
  // Progressively edit a mutable copy so replaceAll can remove several matches,
  // re-materializing between each removal. Nothing is persisted until the
  // caller runs the returned inputs through syncKnowledgeTextBlocks, so a throw
  // mid-way leaves the stored page untouched.
  const working = blocks.map(toWorkingBlock);
  const touched = new Set<string>();

  let replacements = 0;
  while (true) {
    const { text, spans } = materializeBlocksTextWithSpans(working);
    const matchStart = text.indexOf(oldString);
    if (matchStart === -1) break;
    const matchEnd = matchStart + oldString.length;

    const byId = new Map(working.map((b) => [b.id, b]));
    let mutated = false;
    for (const span of spans) {
      const overlapStart = Math.max(matchStart, span.start);
      const overlapEnd = Math.min(matchEnd, span.end);
      if (overlapStart >= overlapEnd) continue; // this block isn't covered

      const block = byId.get(span.blockId)!;

      // fully covered → drop the block; no offset mapping needed, so this is
      // safe for html blocks too (and is how whole sections get removed)
      if (overlapStart <= span.start && overlapEnd >= span.end) {
        block.content = "";
        touched.add(block.id);
        mutated = true;
        continue;
      }
      if (block.type !== "markdown") throw new Error(SPANS_BLOCKS_MESSAGE);

      const rendered = text.slice(span.start, span.end);
      block.content =
        rendered.slice(0, overlapStart - span.start) +
        rendered.slice(overlapEnd - span.start);
      touched.add(block.id);
      mutated = true;
    }

    // The match sat entirely in the separators between blocks (e.g. oldString
    // is only blank lines): nothing to remove and looping would never end.
    if (!mutated) break;

    replacements++;
    if (!replaceAll) break;
  }

  if (replacements === 0) throw new Error(SPANS_BLOCKS_MESSAGE);

  const inputs: KnowledgeTextBlockInput[] = working
    .filter((b) => b.content.trim().length > 0 || !touched.has(b.id))
    .map((b) => ({ id: b.id, type: b.type, content: b.content, meta: b.meta }));

  return { inputs, replacements };
};

export type EditKnowledgeTextResult = {
  id: string;
  replacements: number;
  /** the page text after the edit */
  content: string;
};

/**
 * Exact string replacement in a page's content.
 *
 * - `oldString` must occur in the page; with `replaceAll: false` (default)
 *   it must occur exactly once, otherwise the edit is rejected with a
 *   descriptive error (agents then send a longer, unique string)
 * - on block pages the replacement happens inside the affected blocks; a block
 *   left empty by the edit is dropped rather than kept as an empty placeholder
 * - a deletion (`newString: ""`) whose `oldString` spans several blocks removes
 *   the fully covered blocks at once; a non-empty replacement across a block
 *   boundary is still rejected, as there's no unambiguous block for the result
 */
export const editKnowledgeTextContent = async (
  id: string,
  edit: { oldString: string; newString: string; replaceAll?: boolean },
  context: Context
): Promise<EditKnowledgeTextResult> => {
  const { oldString, newString, replaceAll = false } = edit;
  if (oldString.length === 0) {
    throw new Error("oldString must not be empty");
  }
  if (oldString === newString) {
    throw new Error("oldString and newString are identical");
  }

  const page = await getKnowledgeTextById(id, context);

  // ----- plain text pages -------------------------------------------------
  if (page.contentMode === "text") {
    const occurrences = countOccurrences(page.text, oldString);
    if (occurrences === 0) {
      throw new Error("oldString not found in the document");
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `oldString is not unique (${occurrences} occurrences). ` +
          "Provide more surrounding context or set replaceAll: true"
      );
    }
    const newText = replaceAllOccurrences(page.text, oldString, newString);
    const updated = await updateKnowledgeText(id, { text: newText }, context);
    return { id, replacements: occurrences, content: updated.text };
  }

  // ----- block pages ------------------------------------------------------
  const blocks = await getKnowledgeTextBlocks(id, context);
  const matches = blocks.map((block) => matchInBlock(block, oldString));
  const totalOccurrences = matches.reduce((sum, m) => sum + m.count, 0);
  // the blocks are the source of truth; deriving the "before" text from them
  // (rather than from the page's cached text column) keeps the round-trip check
  // honest even if the cache is stale
  const currentText = materializeBlocksText(blocks);

  if (totalOccurrences === 0) {
    // Not found inside any single block. It may still exist in the materialized
    // text, straddling the gap between adjacent blocks. Deleting such a span is
    // supported — it's the clean way to remove one or more whole blocks at once
    // — but replacing it is not, because there's no unambiguous block to put
    // the replacement text into.
    const spanning = countOccurrences(currentText, oldString);
    if (spanning === 0) {
      throw new Error("oldString not found in the document");
    }
    if (newString.length > 0) {
      throw new Error(SPANS_BLOCKS_MESSAGE);
    }
    if (spanning > 1 && !replaceAll) {
      throw new Error(
        `oldString is not unique (${spanning} occurrences). ` +
          "Provide more surrounding context or set replaceAll: true"
      );
    }
    const { inputs, replacements } = deleteSpanningText(
      blocks,
      oldString,
      replaceAll
    );
    assertRoundTrips(
      currentText,
      { oldString, newString, replaceAll: replaceAll && replacements > 1 },
      inputs
    );
    const result = await syncKnowledgeTextBlocks(id, inputs, context);
    return { id, replacements, content: result.knowledgeText.text };
  }
  if (totalOccurrences > 1 && !replaceAll) {
    throw new Error(
      `oldString is not unique (${totalOccurrences} occurrences). ` +
        "Provide more surrounding context or set replaceAll: true"
    );
  }

  // Block structure written as markdown into an html block would be stored as
  // raw text and come back mangled — refuse it up front, with a message that
  // names the alternatives.
  const touchesHtml = blocks.some(
    (block, i) => matches[i]!.count > 0 && block.type === "html"
  );
  if (touchesHtml && newString.includes("\n")) {
    throw new Error(HTML_BLOCK_STRUCTURE_MESSAGE);
  }

  // Apply the replacement inside each affected block. When a replacement leaves
  // a block empty (e.g. deleting its whole content), drop the block rather than
  // keep it as an empty placeholder — otherwise the editor renders a stray
  // blank block. Blocks the edit didn't touch are passed through untouched,
  // including any that were already empty.
  const nextBlocks = blocks.map((block, i) => ({
    id: block.id,
    type: block.type,
    content:
      matches[i]!.count > 0
        ? matches[i]!.replaced(blockReplacement(block, newString))
        : block.content,
    meta: (block.meta ?? {}) as Record<string, unknown>,
  }));
  const keptBlocks = nextBlocks.filter(
    (block, i) => matches[i]!.count === 0 || block.content.trim().length > 0
  );

  assertRoundTrips(
    currentText,
    { oldString, newString, replaceAll: totalOccurrences > 1 },
    keptBlocks
  );

  const result = await syncKnowledgeTextBlocks(id, keptBlocks, context);

  return {
    id,
    replacements: totalOccurrences,
    content: result.knowledgeText.text,
  };
};
