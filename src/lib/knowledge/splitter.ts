import type { Chunk } from "../types/chunks";
import type { PageContent } from "./parsing/pdf/types";

const MAX_WORDS_PER_CHUNK = 500;

/**
 * Hard upper bound on a single chunk's character length.
 *
 * The Mistral `mistral-embed` model has a hard limit of 8192 tokens per
 * input. For typical English text the token-to-character ratio is roughly
 * 1:4, but OCR'd technical documents (lots of short codes, partial words,
 * separator symbols) and binary content that accidentally ended up as
 * "text" can degrade to nearly 1:1. Empirically the chunks that crashed
 * the knowledge sync had ~1 char per token, so we cap chunk size well
 * below the 8192 token ceiling to leave headroom for these worst-case
 * inputs.
 */
const MAX_CHARS_PER_CHUNK = 6000;

// Counts words in a given text (consecutive sequences separated by whitespace).
const countWords = (text: string): number => {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
};

/**
 * Hard-split a single string into pieces no longer than
 * `MAX_CHARS_PER_CHUNK`.
 *
 * Tries to break at paragraph / line / sentence / whitespace boundaries
 * first, and falls back to a hard character cut if no friendly boundary
 * exists in the look-back window. The result is therefore guaranteed to
 * satisfy the cap regardless of the input — even pathological inputs
 * such as a 1 MB blob without any whitespace.
 */
export const hardSplitText = (text: string): string[] => {
  if (text.length <= MAX_CHARS_PER_CHUNK) return [text];

  const out: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const remaining = text.length - pos;
    if (remaining <= MAX_CHARS_PER_CHUNK) {
      out.push(text.slice(pos));
      break;
    }

    const windowEnd = pos + MAX_CHARS_PER_CHUNK;
    // Look back for a friendly boundary inside the last 20% of the window.
    const minBoundary = pos + Math.floor(MAX_CHARS_PER_CHUNK * 0.8);
    let cut = -1;

    // 1) Paragraph break (blank line)
    for (let i = windowEnd; i > minBoundary; i--) {
      if (text[i] === "\n" && text[i - 1] === "\n") {
        cut = i + 1;
        break;
      }
    }

    // 2) Single newline
    if (cut === -1) {
      for (let i = windowEnd; i > minBoundary; i--) {
        if (text[i] === "\n") {
          cut = i + 1;
          break;
        }
      }
    }

    // 3) Sentence end (".", "!", "?" followed by whitespace)
    if (cut === -1) {
      for (let i = windowEnd; i > minBoundary; i--) {
        const ch = text[i];
        const next = text[i + 1] ?? "";
        if ((ch === "." || ch === "!" || ch === "?") && /\s/.test(next)) {
          cut = i + 2;
          break;
        }
      }
    }

    // 4) Any whitespace
    if (cut === -1) {
      for (let i = windowEnd; i > minBoundary; i--) {
        if (/\s/.test(text[i] ?? "")) {
          cut = i + 1;
          break;
        }
      }
    }

    // 5) Hard cut at the window edge
    if (cut === -1 || cut <= pos) {
      cut = windowEnd;
    }

    out.push(text.slice(pos, cut));
    pos = cut;
  }

  return out.filter((s) => s.length > 0);
};

/**
 * Final safety net: ensure no chunk in the list exceeds
 * `MAX_CHARS_PER_CHUNK`. Oversized chunks are split via `hardSplitText`,
 * preserving the original `header` and `meta`. Sequential `order` values
 * are assigned across the resulting list.
 */
const enforceCharLimit = (chunks: Chunk[]): Chunk[] => {
  const result: Chunk[] = [];
  let order = 0;
  for (const chunk of chunks) {
    if (chunk.text.length <= MAX_CHARS_PER_CHUNK) {
      result.push({ ...chunk, order: order++ });
      continue;
    }
    const parts = hardSplitText(chunk.text);
    for (const part of parts) {
      result.push({
        text: part,
        header: chunk.header,
        order: order++,
        meta: chunk.meta,
      });
    }
  }
  return result;
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
 *
 * In addition to the soft word-based limit the splitter enforces a hard
 * character cap (`MAX_CHARS_PER_CHUNK`) so the resulting chunks always fit
 * the embedding API's token budget — even for pathological inputs where
 * the heuristics (heading detection, table protection, blank-line breaks)
 * cannot find a good split point. See `hardSplitText` for details.
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
    // `enforceCharLimit` re-numbers the chunks sequentially across all pages
    // and also acts as a final safety net against oversized pieces.
    return enforceCharLimit(all);
  }

  ////////////////////////////////////////////////////////////////
  // Below: processing for a single string (markdown/plain text) //
  ////////////////////////////////////////////////////////////////

  const text = input;

  // Short-circuit for small inputs — but only when both the soft (words) and
  // the hard (chars) limit are satisfied, otherwise we still need to split.
  if (
    countWords(text) <= MAX_WORDS_PER_CHUNK &&
    text.length <= MAX_CHARS_PER_CHUNK
  ) {
    return [buildChunk(text, undefined)];
  }

  const chunks: Chunk[] = [];

  // Work line based – this helps to keep structures such as tables intact.
  const lines = text.split(/\r?\n/);

  let currentHeader: string | undefined = undefined;
  let currentLines: string[] = [];
  let currentWordCount = 0;
  let currentCharCount = 0;
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
    currentCharCount = 0;
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

    // Special case: A *single* line is already too big for a chunk.
    //
    // We force-split here on either the soft (words) or the hard (chars)
    // limit. The hard char check intentionally ignores the protective
    // table/code-fence flags — a multi-MB "table line" that keeps
    // `insideTable` permanently true would otherwise never be flushed and
    // would crash the embedding API. The Mistral embedder doesn't care
    // about Markdown structure anyway.
    const lineExceedsCharLimit = line.length > MAX_CHARS_PER_CHUNK;
    const lineExceedsWordLimit =
      wordsInLine >= MAX_WORDS_PER_CHUNK && !insideCodeFence && !insideTable;

    if (lineExceedsWordLimit || lineExceedsCharLimit) {
      // Flush previous collected lines first so ordering stays intact.
      pushCurrentLines();

      // Word-based split first; fall back to a hard char split for any
      // pieces that are still too large (single "word" longer than
      // `MAX_CHARS_PER_CHUNK`, or input with no whitespace at all).
      const words = line.split(/\s+/).filter((w) => w.length > 0);
      if (words.length === 0) {
        for (const sub of hardSplitText(line)) {
          chunks.push(buildChunk(sub, currentHeader));
        }
      } else {
        while (words.length) {
          const slice = words.splice(0, MAX_WORDS_PER_CHUNK);
          const piece = slice.join(" ");
          for (const sub of hardSplitText(piece)) {
            chunks.push(buildChunk(sub, currentHeader));
          }
        }
      }
      continue; // We already handled this line.
    }

    // Normal path: just add the line to the current buffer.
    currentLines.push(line);
    currentWordCount += wordsInLine;
    currentCharCount += line.length + 1; // +1 for the joining "\n"

    // Time to possibly create a new chunk?
    const wordLimitHit =
      currentWordCount >= MAX_WORDS_PER_CHUNK &&
      !insideCodeFence &&
      !insideTable;
    const charLimitHit = currentCharCount >= MAX_CHARS_PER_CHUNK;

    if (wordLimitHit || charLimitHit) {
      // Prefer to split at blank lines or before next heading to keep
      // markdown readable. The char-limit branch always flushes — it's the
      // hard safety valve and ignores the table/code-fence stickiness on
      // purpose.
      const nextLine = lines[i + 1] ?? "";
      const nextTrimmed = nextLine.trim();
      const nextIsHeading = /^#{1,6}\s+/.test(nextTrimmed);

      if (charLimitHit || nextTrimmed === "" || nextIsHeading) {
        pushCurrentLines();
      }
    }
  }

  // Flush remainder
  pushCurrentLines();

  // Final safety net: split any chunk that is still over the char cap and
  // re-number `order` sequentially.
  return enforceCharLimit(chunks);
};
