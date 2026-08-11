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
 * materialized markdown) of what it writes to (the stored html). Three rules
 * keep that honest:
 *
 *   - matching inside an html block tolerates exactly the differences the
 *     round trip introduces — a reference stored as a `<code data-wiki-link>`
 *     element with whatever attributes the editor added, entity-encoded
 *     characters, collapsed whitespace (`wikiLinkTolerantHtmlPattern`)
 *   - whatever the stored html cannot carry — text the projection FORMATS
 *     (`**bold**`, `## heading`, list markers), or a replacement with line
 *     breaks — is applied to the projection itself, and the block is then
 *     stored as a markdown block (`matchInBlock`, strategy 3). Both block types
 *     are first class: an import writes markdown blocks, and the web editor
 *     renders them and normalizes them back to html on the next human save.
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
  renderBlockText,
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

/** A block's stored form: which format the content is written in. */
type BlockContent = { type: "markdown" | "html"; content: string };

type BlockMatch = {
  /** how often `oldString` occurs in this block */
  count: number;
  /** the block with every occurrence replaced by `newString` */
  apply: () => BlockContent;
};

/**
 * Find `oldString` inside one block and describe the block with every
 * occurrence replaced. An agent copies `oldString` out of the materialized
 * text, which for an html block is Turndown's rendering of the stored html, so
 * three strategies are tried — in the order of how much of the stored block
 * they preserve:
 *
 *   1. a literal search in the stored content. The fast path, and the whole
 *      story for markdown blocks: they store their text verbatim.
 *   2. for html blocks, a pattern that tolerates exactly the differences the
 *      round trip introduces: references stored as `<code data-wiki-link>`
 *      elements (whatever attributes the editor put on them), entity-encoded
 *      characters and collapsed whitespace.
 *   3. for html blocks, a search in the block's PROJECTION — the markdown the
 *      agent actually read. Everything the projection formats is invisible to
 *      1 and 2: a paragraph holding one bold word reads as `**bold**`, a
 *      heading as `## Title`, a list as `*   item`, so copying any of it back
 *      used to fail as "not found" no matter how exact the copy was. Here the
 *      edit is applied to the markdown and the block is stored AS a markdown
 *      block — which also lets the replacement carry structure (line breaks,
 *      lists) that html-in-one-block cannot hold.
 *
 * Strategy 3 loses whatever Turndown does not express (inline styles, custom
 * attributes) for that one block, so it stays the last resort: it runs only
 * when 1 and 2 miss, or when `newString` brings line breaks that the stored
 * html could not carry anyway.
 */
const matchInBlock = (
  block: Pick<KnowledgeTextBlockSelect, "type" | "content">,
  oldString: string,
  newString: string
): BlockMatch => {
  if (block.type !== "html") {
    return {
      count: countOccurrences(block.content, oldString),
      apply: () => ({
        type: block.type,
        content: replaceAllOccurrences(block.content, oldString, newString),
      }),
    };
  }

  // Wikilinks written into an html block ("[[Target]]") are stored in the
  // editor's canonical `<code data-wiki-link>` form, so a reference an agent
  // writes is a real, clickable page link — exactly like one inserted by hand.
  // Markdown blocks keep the plain marker (that IS their canonical form).
  const html = (count: number, content: () => string): BlockMatch => ({
    count,
    apply: () => ({ type: "html", content: content() }),
  });
  const literal = countOccurrences(block.content, oldString);
  const pattern = wikiLinkTolerantHtmlPattern(oldString);
  const tolerant = literal > 0 ? 0 : block.content.match(pattern)?.length ?? 0;
  const inHtml = (): BlockMatch | null => {
    if (literal > 0)
      return html(literal, () =>
        replaceAllOccurrences(
          block.content,
          oldString,
          wikiLinksToHtml(newString)
        )
      );
    if (tolerant > 0)
      // a function replacement, so `$&` and friends in the replacement text
      // are inserted literally
      return html(tolerant, () =>
        block.content.replace(pattern, () => wikiLinksToHtml(newString))
      );
    return null;
  };

  // Block structure written as markdown into an html block would be stored as
  // raw text and come back mangled, so a replacement carrying line breaks goes
  // through the projection even when the html itself would match.
  const structural = newString.includes("\n");
  if (!structural) {
    const match = inHtml();
    if (match) return match;
  }

  const projection = renderBlockText(block);
  const projected = countOccurrences(projection, oldString);
  if (projected > 0) {
    return {
      count: projected,
      apply: () => ({
        type: "markdown",
        content: replaceAllOccurrences(projection, oldString, newString),
      }),
    };
  }

  // Structural replacement, but the text matches only the stored html: let the
  // html path run so the round-trip check reports the real problem.
  return (
    inHtml() ?? {
      count: 0,
      apply: () => ({ type: block.type, content: block.content }),
    }
  );
};

/** Message used when a cross-block match can't be resolved to a clean edit. */
const SPANS_BLOCKS_MESSAGE =
  "oldString spans multiple blocks and could not be resolved to a clean " +
  "edit. Edit the blocks individually (PUT .../blocks), or use a string that " +
  "either stays within one block or covers whole blocks";

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
 * Replace every (or the first) occurrence of an `oldString` that spans several
 * blocks, mapping the edit back onto the underlying blocks: blocks the match
 * fully covers are emptied (and later dropped), boundary blocks keep the part
 * outside the match, and `newString` lands in the first covered block.
 *
 * A block the match covers COMPLETELY is dropped whatever its type — no
 * offsets need mapping for that, so removing a whole section (heading plus
 * list, however it is stored) works. A PARTIALLY covered block keeps the
 * surviving part of its PROJECTION and is stored as a markdown block: the
 * offsets of the match are positions in the materialized markdown, and only
 * markdown can hold them unambiguously. (For a block that was already markdown
 * this is a no-op — the projection is its content.)
 *
 * Returns the surviving block inputs (emptied blocks removed) and the number
 * of matches replaced.
 */
const replaceSpanningText = (
  blocks: KnowledgeTextBlockSelect[],
  oldString: string,
  newString: string,
  limit: number
): { inputs: KnowledgeTextBlockInput[]; replacements: number } => {
  // Progressively edit a mutable copy so replaceAll can handle several matches,
  // re-materializing between each one. Nothing is persisted until the caller
  // runs the returned inputs through syncKnowledgeTextBlocks, so a throw
  // mid-way leaves the stored page untouched.
  const working = blocks.map(toWorkingBlock);
  const touched = new Set<string>();

  let replacements = 0;
  // where to resume scanning: past the text just written, so a newString that
  // contains oldString cannot be rewritten forever
  let searchFrom = 0;
  while (replacements < limit) {
    const { text, spans } = materializeBlocksTextWithSpans(working);
    const matchStart = text.indexOf(oldString, searchFrom);
    if (matchStart === -1) break;
    const matchEnd = matchStart + oldString.length;

    const byId = new Map(working.map((b) => [b.id, b]));
    const covered: { block: WorkingBlock; prefix: string; suffix: string }[] =
      [];
    for (const span of spans) {
      const overlapStart = Math.max(matchStart, span.start);
      const overlapEnd = Math.min(matchEnd, span.end);
      if (overlapStart >= overlapEnd) continue; // this block isn't covered

      const rendered = text.slice(span.start, span.end);
      covered.push({
        block: byId.get(span.blockId)!,
        prefix: rendered.slice(0, overlapStart - span.start),
        suffix: rendered.slice(overlapEnd - span.start),
      });
    }

    // The match sat entirely in the separators between blocks (e.g. oldString
    // is only blank lines): nothing to change and looping would never end.
    if (covered.length === 0) break;

    covered.forEach(({ block, prefix, suffix }, index) => {
      // the replacement goes where the match started
      const content = index === 0 ? prefix + newString + suffix : prefix + suffix;
      block.content = content;
      // what survives came out of the projection, so it is markdown now
      if (content.length > 0) block.type = "markdown";
      touched.add(block.id);
    });

    replacements++;
    searchFrom = matchStart + newString.length;
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
 * - an `oldString` that spans several blocks (copied verbatim out of a read,
 *   blank lines and all) is edited across them: fully covered blocks are
 *   removed, boundary blocks keep what lies outside the match, and `newString`
 *   lands where the match started
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
  const matches = blocks.map((block) =>
    matchInBlock(block, oldString, newString)
  );
  const totalOccurrences = matches.reduce((sum, m) => sum + m.count, 0);
  // the blocks are the source of truth; deriving the "before" text from them
  // (rather than from the page's cached text column) keeps the round-trip check
  // honest even if the cache is stale
  const currentText = materializeBlocksText(blocks);

  if (totalOccurrences === 0) {
    // Not found inside any single block. It may still exist in the materialized
    // text, straddling the gap between adjacent blocks — the shape of every
    // edit that covers more than one paragraph, so it is applied across the
    // blocks it touches.
    const spanning = countOccurrences(currentText, oldString);
    if (spanning === 0) {
      throw new Error("oldString not found in the document");
    }
    if (spanning > 1 && !replaceAll) {
      throw new Error(
        `oldString is not unique (${spanning} occurrences). ` +
          "Provide more surrounding context or set replaceAll: true"
      );
    }
    const { inputs, replacements } = replaceSpanningText(
      blocks,
      oldString,
      newString,
      replaceAll ? spanning : 1
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

  // Apply the replacement inside each affected block. When a replacement leaves
  // a block empty (e.g. deleting its whole content), drop the block rather than
  // keep it as an empty placeholder — otherwise the editor renders a stray
  // blank block. Blocks the edit didn't touch are passed through untouched,
  // including any that were already empty.
  const nextBlocks = blocks.map((block, i) => {
    const next =
      matches[i]!.count > 0
        ? matches[i]!.apply()
        : { type: block.type, content: block.content };
    return {
      id: block.id,
      type: next.type,
      content: next.content,
      meta: (block.meta ?? {}) as Record<string, unknown>,
    };
  });
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
