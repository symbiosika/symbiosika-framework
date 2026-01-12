ALTER TABLE "base_knowledge_text" DROP CONSTRAINT "knowledge_text_text_min_length";--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ALTER COLUMN "text" SET DEFAULT '';