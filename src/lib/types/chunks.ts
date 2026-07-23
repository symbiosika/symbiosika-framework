export type Chunk = {
  text: string;
  header: string | undefined;
  order: number;
  meta?: {
    page?: number;
    /**
     * Id of the source content block this chunk starts in, when the chunked
     * document was assembled from addressable blocks (wiki pages in block
     * mode). Lets a UI jump from a retrieved chunk back to the exact spot in
     * the rendered document. Absent for chunks whose source has no blocks
     * (PDF/URL/file imports).
     */
    blockId?: string;
  };
};

export type ChunkWithEmbedding = Chunk & {
  embedding: { embedding: number[]; model: string; dimensions: number };
};
