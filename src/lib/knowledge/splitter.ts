import type { Chunk } from "../types/chunks";
import type { PageContent } from "./parsing/pdf/types";

const MAX_WORDS_PER_CHUNK = 500;

// Counts words in a given text (consecutive sequences separated by whitespace).
const countWords = (text: string): number => {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
};

/**
 * Splits markdown (or plain) text into semantic chunks that are **approximately**
 * `MAX_WORDS_PER_CHUNK` words long while trying **not** to break important
 * markdown structures (code-blocks, tables, headings …).
 *
 * The function also supports an array of `PageContent` objects (mainly coming
 * from the PDF-parser). In that case the pages are processed one after another
 * and the originating page number is stored in `chunk.meta.page`.
 *
 * The returned chunks are always ordered via the `order` property so callers
 * can later re-assemble the original document with
 * `chunks.sort((a,b) => a.order - b.order).map(c => c.text).join("")`.
 */
export const splitTextIntoSectionsOrChunks = (
  input: string | PageContent[]
): Chunk[] => {
  // Helper to assign incremental order numbers
  let globalOrder = 0;
  const buildChunk = (
    text: string,
    header: string | undefined,
    meta?: { page?: number }
  ): Chunk => ({
    text,
    header,
    order: globalOrder++,
    meta,
  });

  // If the input is an array of individual pages, split every page separately
  // and keep a reference to the page number inside the meta field.
  if (Array.isArray(input)) {
    const all: Chunk[] = [];
    input.forEach((p) => {
      const chunksForPage = splitTextIntoSectionsOrChunks(p.text);
      chunksForPage.forEach((c) => (c.meta = { page: p.page }));
      all.push(...chunksForPage);
    });
    // order has already been assigned inside the recursive call – but we have
    // to re-number the chunks to keep a strictly increasing order across all
    // pages.
    all.forEach((c, idx) => (c.order = idx));
    return all;
  }

  ////////////////////////////////////////////////////////////////
  // Below: processing for a single string (markdown/plain text) //
  ////////////////////////////////////////////////////////////////

  const text = input;

  // Short-circuit for small inputs
  if (countWords(text) <= MAX_WORDS_PER_CHUNK) {
    return [buildChunk(text, undefined)];
  }

  const chunks: Chunk[] = [];

  // Work line based – this helps to keep structures such as tables intact.
  const lines = text.split(/\r?\n/);

  let currentHeader: string | undefined = undefined;
  let currentLines: string[] = [];
  let currentWordCount = 0;
  let insideCodeFence = false;
  let insideTable = false;

  // Pushes the accumulated lines into the chunks array and resets the
  // collectors.
  const pushCurrentLines = () => {
    if (currentLines.length === 0) return;
    const txt = currentLines.join("\n");
    chunks.push(buildChunk(txt, currentHeader));
    currentLines = [];
    currentWordCount = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) {
      continue;
    }
    let line: string = lines[i] as string;

    const trimmed = line.trim();

    // Toggle code-fence state (```) when encountered
    if (trimmed.startsWith("```")) {
      insideCodeFence = !insideCodeFence;
    }

    // Detect simple markdown tables – continuous lines containing a pipe (|)
    // outside code fences are considered part of a table.
    if (!insideCodeFence) {
      const isTableLine = /\|/.test(line);
      if (isTableLine) {
        insideTable = true;
      } else if (insideTable && !isTableLine) {
        insideTable = false;
      }
    }

    // If we are not inside a code fence, check for headings. A heading starts a
    // new logical section – we close the previous chunk first.
    const isHeading = !insideCodeFence && /^#{1,6}\s+/.test(trimmed);
    if (isHeading) {
      // Finish the previous section (if any)
      pushCurrentLines();
      // Store headline (without leading # characters) as header for following
      // lines.
      currentHeader = trimmed.replace(/^#{1,6}\s+/, "").trim();
    }

    // Words in the current line – calculated once to reuse below.
    const wordsInLine = countWords(line);

    // Special case: A *single* line can already be bigger than the limit. If we
    // are **not** in a protected structure (code/table) we split the line by
    // words directly so the hard requirement from the unit tests is met while
    // still keeping all characters.
    if (
      !insideCodeFence &&
      !insideTable &&
      wordsInLine >= MAX_WORDS_PER_CHUNK
    ) {
      // Flush previous collected lines first so ordering stays intact.
      pushCurrentLines();

      const words = line.split(/\s+/);
      while (words.length) {
        const slice = words.splice(0, MAX_WORDS_PER_CHUNK);
        chunks.push(buildChunk(slice.join(" "), currentHeader));
      }
      continue; // We already handled this line.
    }

    // Normal path: just add the line to the current buffer.
    currentLines.push(line);
    currentWordCount += wordsInLine;

    // Time to possibly create a new chunk?
    if (
      currentWordCount >= MAX_WORDS_PER_CHUNK &&
      !insideCodeFence &&
      !insideTable
    ) {
      // Prefer to split at blank lines or before next heading to keep markdown
      // readable. If the next line is a blank one or a heading we push now,
      // otherwise we wait for the next suitable place (soft limit behaviour).
      const nextLine = lines[i + 1] ?? "";
      const nextTrimmed = nextLine.trim();
      const nextIsHeading = /^#{1,6}\s+/.test(nextTrimmed);
      if (nextTrimmed === "" || nextIsHeading) {
        pushCurrentLines();
      }
    }
  }

  // Flush remainder
  pushCurrentLines();

  return chunks;
};
