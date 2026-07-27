CREATE TYPE "public"."knowledge_public_mode" AS ENUM('public', 'excluded');--> statement-breakpoint
ALTER TABLE "base_knowledge_entry" ADD COLUMN "public_effective" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "public_mode" "knowledge_public_mode";--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "public_effective" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "knowledge_entry_public_effective_idx" ON "base_knowledge_entry" USING btree ("tenant_id","public_effective");--> statement-breakpoint
CREATE INDEX "knowledge_text_public_effective_idx" ON "base_knowledge_text" USING btree ("tenant_id","public_effective");