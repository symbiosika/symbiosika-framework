-- Re-generated drop of the dead knowledge_filters table (its code was removed
-- in PR #72; the schema no longer contains it, so drizzle keeps diffing the
-- drop until it lands in a migration). IF EXISTS so environments where the
-- table was already dropped manually migrate cleanly.
DROP TABLE IF EXISTS "base_knowledge_filters" CASCADE;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "knowledge_text_attributes_idx" ON "base_knowledge_text" USING gin ("attributes" jsonb_path_ops);