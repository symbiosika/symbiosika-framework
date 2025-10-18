export type Chunk = {
  text: string;
  header: string | undefined;
  order: number;
  meta?: { page?: number };
};

export type ChunkWithEmbedding = Chunk & {
  embedding: { embedding: number[]; model: string };
};
