/**
 * Block provenance for chunks.
 *
 * When a wiki page in block mode is mirrored into the RAG pipeline, its
 * content is first materialized into a single markdown blob (see
 * `materializeBlocksTextWithSpans`) and then chunked. Chunking is a pure
 * function of that blob and is intentionally left untouched here — chunk
 * boundaries, text and embeddings stay exactly as they are.
 *
 * This module adds, as a post-processing step, the missing back-reference:
 * for every chunk it records the id of the content block the chunk STARTS in,
 * stored on `chunk.meta.blockId`. That lets the UI jump from a retrieved chunk
 * (search hit, RAG citation) straight to the right block in the rendered
 * document.
 *
 * The mapping is offset-based and does not depend on the chunking strategy:
 * chunks are produced in reading order, so a single forward cursor over the
 * source text locates each chunk's start offset, which is then matched against
 * the block spans. It degrades gracefully — a chunk whose anchor cannot be
 * located inherits the previous chunk's block (chunks are ordered, so that is
 * the nearest preceding block), and everything no-ops when no spans are given.
 */

import type { Chunk } from "../types/chunks";

/** Half-open character range `[start, end)` of one block in the source text. */
export type BlockSpan = {
  blockId: string;
  start: number;
  end: number;
};

/** First non-empty line of a chunk, used as the search anchor. */
const firstAnchorLine = (text: string): string | null => {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
};

/** The block span that contains `offset` (or the last span that starts before it). */
const blockAtOffset = (spans: BlockSpan[], offset: number): string | null => {
  let candidate: string | null = null;
  for (const span of spans) {
    if (offset < span.start) break;
    // within the span, or past its end but no later span has started yet
    candidate = span.blockId;
    if (offset < span.end) return span.blockId;
  }
  return candidate;
};

/**
 * Annotate each chunk with the id of the block it starts in.
 *
 * Mutates the chunks in place (sets `chunk.meta.blockId`) and returns them for
 * convenience. `spans` must describe blocks within `text` in ascending order;
 * pass the output of `materializeBlocksTextWithSpans`. Chunks are expected in
 * reading order (as every splitter emits them).
 */
export const assignBlockProvenance = (
  chunks: Chunk[],
  text: string,
  spans: BlockSpan[]
): Chunk[] => {
  if (spans.length === 0) return chunks;

  let cursor = 0;
  let lastBlockId: string | null = null;

  for (const chunk of chunks) {
    const anchor = firstAnchorLine(chunk.text);
    let offset = -1;
    if (anchor) {
      offset = text.indexOf(anchor, cursor);
      // Retry from the top in case ordering assumptions broke (e.g. a splitter
      // reordered content); better a correct-but-backwards match than none.
      if (offset === -1) offset = text.indexOf(anchor);
    }

    const blockId: string | null =
      offset === -1 ? lastBlockId : blockAtOffset(spans, offset);

    if (blockId) {
      chunk.meta = { ...(chunk.meta ?? {}), blockId };
      lastBlockId = blockId;
    }

    if (offset !== -1) {
      cursor = offset + (anchor?.length ?? 0);
    }
  }

  return chunks;
};
