import type { Chunk } from "../types/chunks";
import type { PageContent } from "./parsing/pdf/types";
import {
  MAX_WORDS_PER_CHUNK,
  MAX_CHARS_PER_CHUNK,
  countWords,
  enforceCharLimit,
  hardSplitText,
} from "./splitter";

/**
 * Smart, markdown-aware chunking (ported from the knowledge-engine prototype's
 * `chunking.py`, adapted to this framework's word/character budget so it stays
 * pure TypeScript — no tokenizer dependency).
 *
 * What it does better than the simple splitter:
 *   - Markdown tables stay ATOMIC (header + rows in one chunk) as long as they
 *     fit the hard character cap. The simple splitter can break a table mid-way.
 *   - A table that exceeds the cap is split into sub-tables that each REPEAT the
 *     table header (and any single-cell "section" row), so every piece stays
 *     self-contained and rankable during retrieval.
 *   - A short heading / caption directly before a table is kept together with
 *     that table so the table keeps its context.
 *   - Free text is chunked at paragraph and heading boundaries: paragraphs are
 *     bundled up to the word budget, a heading always starts a new chunk, and a
 *     single oversized paragraph falls back to `hardSplitText`.
 *
 * The public interface mirrors `splitTextIntoSectionsOrChunks`: pass a markdown
 * string or an array of `PageContent` (from the PDF parsers). For pages, each
 * page is chunked independently and the page number is stored in `chunk.meta`.
 *
 * NOTE: only markdown pipe tables are treated specially. HTML `<table>` markup
 * (rare here — the URL reader emits GFM markdown tables) flows through the text
 * path and is protected only by the character cap.
 */

// A markdown table line starts and ends (trimmed) with a pipe.
const isTableLine = (line: string): boolean => {
  const s = line.trim();
  return s.startsWith("|") && s.endsWith("|") && s.length >= 2;
};

const isHeading = (text: string): boolean => /^#{1,6}\s/.test(text.trimStart());

// Extract the last markdown heading found in a block (without the leading #s),
// used to populate `chunk.header`.
const lastHeadingIn = (text: string): string | undefined => {
  let found: string | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) {
      found = trimmed.replace(/^#{1,6}\s+/, "").trim();
    }
  }
  return found;
};

type Segment = { isTable: boolean; text: string };

/**
 * Split markdown into consecutive table / non-table segments. Runs of pipe
 * lines form a table segment, everything else forms text segments.
 */
const segmentMarkdown = (content: string): Segment[] => {
  const segments: Segment[] = [];
  let buf: string[] = [];
  let bufIsTable = false;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join("\n").trim();
    if (text) segments.push({ isTable: bufIsTable, text });
    buf = [];
  };

  for (const line of content.split("\n")) {
    const isTbl = isTableLine(line);
    if (buf.length > 0 && isTbl !== bufIsTable) {
      flush();
    }
    bufIsTable = isTbl;
    buf.push(line);
  }
  flush();
  return segments;
};

/**
 * Bundle a free-text block into chunks at paragraph / heading boundaries.
 * Returns chunk texts paired with the heading in effect for each.
 */
const splitTextBlock = (
  text: string,
  initialHeader: string | undefined
): { pieces: { text: string; header: string | undefined }[]; endHeader: string | undefined } => {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const pieces: { text: string; header: string | undefined }[] = [];
  let currentHeader = initialHeader;
  let cur: string[] = [];
  let curWords = 0;

  const flush = () => {
    if (cur.length === 0) return;
    const joined = cur.join("\n\n").trim();
    if (joined) pieces.push({ text: joined, header: currentHeader });
    cur = [];
    curWords = 0;
  };

  for (const para of paragraphs) {
    const pWords = countWords(para);

    // A heading starts a new section — flush the previous bundle first, then
    // adopt the heading as the current header.
    if (isHeading(para) && cur.length > 0) {
      flush();
    }
    if (isHeading(para)) {
      const h = lastHeadingIn(para);
      if (h !== undefined) currentHeader = h;
    }

    // A single paragraph over the budget is emitted on its own and hard-split.
    if (pWords > MAX_WORDS_PER_CHUNK || para.length > MAX_CHARS_PER_CHUNK) {
      flush();
      for (const sub of hardSplitText(para)) {
        pieces.push({ text: sub, header: currentHeader });
      }
      continue;
    }

    // Would this paragraph overflow the current bundle? Flush first.
    if (cur.length > 0 && curWords + pWords > MAX_WORDS_PER_CHUNK) {
      flush();
    }
    cur.push(para);
    curWords += pWords;
  }
  flush();
  return { pieces, endHeader: currentHeader };
};

// A single-cell row (e.g. "| Torque specs |  |") that carries context for the
// rows below it in workshop-style tables.
const isSectionRow = (line: string): boolean => {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.replace(/[ *]/g, "").trim());
  return cells.filter((c) => c.length > 0).length === 1;
};

/**
 * Split an oversized markdown table into sub-tables. The prefix (optional
 * merged heading + the header row + separator row) is repeated in every part so
 * each part is self-contained; the current single-cell "section" row is carried
 * into the following part as context.
 */
const splitTableBlock = (text: string): string[] => {
  const lines = text.split("\n");
  const firstTbl = lines.findIndex((l) => isTableLine(l));
  if (firstTbl === -1) return [text];

  let headerEnd = firstTbl + 1;
  // The separator row (|---|:--:|) belongs to the header.
  if (headerEnd < lines.length && /^[\s|:\-]+$/.test(lines[headerEnd] ?? " ")) {
    headerEnd += 1;
  }
  const prefix = lines.slice(0, headerEnd).join("\n");
  const body = lines.slice(headerEnd).filter((l) => l.trim().length > 0);
  if (body.length === 0) return [text];

  const prefixWords = countWords(prefix);
  const prefixChars = prefix.length;
  const wordBudget = Math.max(
    MAX_WORDS_PER_CHUNK - prefixWords,
    Math.floor(MAX_WORDS_PER_CHUNK / 4)
  );
  const charBudget = Math.max(
    MAX_CHARS_PER_CHUNK - prefixChars,
    Math.floor(MAX_CHARS_PER_CHUNK / 4)
  );

  const parts: string[] = [];
  let cur: string[] = [];
  let curWords = 0;
  let curChars = 0;
  let currentSection: string | null = null;

  const flush = () => {
    if (cur.length === 0) return;
    parts.push(prefix + "\n" + cur.join("\n"));
  };

  for (const line of body) {
    const lineWords = countWords(line);
    const lineChars = line.length + 1;
    if (
      cur.length > 0 &&
      (curWords + lineWords > wordBudget || curChars + lineChars > charBudget)
    ) {
      flush();
      // The next part inherits the current section row as context.
      cur = currentSection ? [currentSection] : [];
      curWords = currentSection ? countWords(currentSection) : 0;
      curChars = currentSection ? currentSection.length + 1 : 0;
    }
    if (isSectionRow(line)) {
      currentSection = line;
    }
    cur.push(line);
    curWords += lineWords;
    curChars += lineChars;
  }
  flush();
  return parts.length > 0 ? parts : [text];
};

/**
 * Chunk a single markdown string. Order is assigned later by `enforceCharLimit`,
 * so the returned chunks carry `order: 0` as a placeholder.
 */
const smartChunkString = (text: string): Chunk[] => {
  const segments = segmentMarkdown(text);

  // Merge a short text segment (heading / caption) into the following table so
  // the table keeps its context.
  const headingLimit = Math.max(1, Math.floor(MAX_WORDS_PER_CHUNK / 4));
  const merged: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1];
    if (
      !seg.isTable &&
      next &&
      next.isTable &&
      countWords(seg.text) <= headingLimit
    ) {
      merged.push({ isTable: true, text: seg.text + "\n\n" + next.text });
      i += 1; // consumed the table too
    } else {
      merged.push(seg);
    }
  }

  const chunks: Chunk[] = [];
  let runningHeader: string | undefined;

  for (const seg of merged) {
    if (seg.isTable) {
      const heading = lastHeadingIn(seg.text);
      if (heading !== undefined) runningHeader = heading;
      // Keep the table atomic while it fits the hard cap; otherwise split it
      // into header-repeating sub-tables.
      const parts =
        seg.text.length <= MAX_CHARS_PER_CHUNK
          ? [seg.text]
          : splitTableBlock(seg.text);
      for (const part of parts) {
        chunks.push({ text: part, header: runningHeader, order: 0 });
      }
    } else {
      const { pieces, endHeader } = splitTextBlock(seg.text, runningHeader);
      for (const piece of pieces) {
        chunks.push({ text: piece.text, header: piece.header, order: 0 });
      }
      runningHeader = endHeader;
    }
  }
  return chunks;
};

/**
 * Smart, markdown/table-aware variant of `splitTextIntoSectionsOrChunks`.
 * Accepts a markdown string or an array of `PageContent`.
 */
export const smartSplitTextIntoSectionsOrChunks = (
  input: string | PageContent[]
): Chunk[] => {
  if (Array.isArray(input)) {
    const all: Chunk[] = [];
    input.forEach((p) => {
      const forPage = smartChunkString(p.text);
      forPage.forEach((c) => (c.meta = { page: p.page }));
      all.push(...forPage);
    });
    // `enforceCharLimit` re-numbers order sequentially and acts as a final
    // safety net against any piece still over the character cap.
    return enforceCharLimit(all);
  }
  return enforceCharLimit(smartChunkString(input));
};
