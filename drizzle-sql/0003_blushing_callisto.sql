DELETE FROM "base_knowledge_text";

ALTER TABLE "base_knowledge_text" ADD COLUMN "document_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "is_latest" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "knowledge_text_document_id_idx" ON "base_knowledge_text" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_document_latest_idx" ON "base_knowledge_text" USING btree ("document_id","is_latest");