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
 * through the normal block sync, so text cache, history, wikilinks and the
 * embedding mirror all stay consistent.
 */

import {
  getKnowledgeTextById,
  updateKnowledgeText,
} from "./knowledge-texts";
import {
  getKnowledgeTextBlocks,
  syncKnowledgeTextBlocks,
} from "./knowledge-text-blocks";

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
 * - on block pages the replacement happens inside the affected blocks; an
 *   `oldString` spanning two blocks is rejected with a clear error
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
  const occurrencesPerBlock = blocks.map((block) =>
    countOccurrences(block.content, oldString)
  );
  const totalOccurrences = occurrencesPerBlock.reduce((a, b) => a + b, 0);

  if (totalOccurrences === 0) {
    // distinguish "not present at all" from "spans block boundaries"
    if (countOccurrences(page.text, oldString) > 0) {
      throw new Error(
        "oldString spans multiple blocks. Edit the blocks individually " +
          "(PUT .../blocks) or use a shorter string within one block"
      );
    }
    throw new Error("oldString not found in the document");
  }
  if (totalOccurrences > 1 && !replaceAll) {
    throw new Error(
      `oldString is not unique (${totalOccurrences} occurrences). ` +
        "Provide more surrounding context or set replaceAll: true"
    );
  }

  const result = await syncKnowledgeTextBlocks(
    id,
    blocks.map((block, i) => ({
      id: block.id,
      type: block.type,
      content:
        occurrencesPerBlock[i]! > 0
          ? replaceAllOccurrences(block.content, oldString, newString)
          : block.content,
      meta: (block.meta ?? {}) as Record<string, unknown>,
    })),
    context
  );

  return {
    id,
    replacements: totalOccurrences,
    content: result.knowledgeText.text,
  };
};
