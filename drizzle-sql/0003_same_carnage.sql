ALTER TABLE "base_knowledge_chunks" ALTER COLUMN "text_embedding_1536" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_chunks" ALTER COLUMN "text_embedding_1024" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_embedding_required" CHECK (text_embedding_1536 IS NOT NULL OR text_embedding_1024 IS NOT NULL);