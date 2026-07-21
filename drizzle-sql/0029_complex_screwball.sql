CREATE INDEX "knowledge_chunks_embedding_1024_hnsw_idx" ON "base_knowledge_chunks" USING hnsw ("text_embedding_1024" vector_cosine_ops) WHERE text_embedding_1024 IS NOT NULL;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_1536_hnsw_idx" ON "base_knowledge_chunks" USING hnsw ("text_embedding_1536" vector_cosine_ops) WHERE text_embedding_1536 IS NOT NULL;--> statement-breakpoint
-- Backfill `dimensions`: the insert paths never wrote it (default 0), but
-- knowledge-text-links.ts routes by it when picking the embedding column.
-- Derive it from whichever vector column is populated.
UPDATE "base_knowledge_chunks"
SET "dimensions" = CASE WHEN "text_embedding_1536" IS NOT NULL THEN 1536 ELSE 1024 END
WHERE "dimensions" = 0;