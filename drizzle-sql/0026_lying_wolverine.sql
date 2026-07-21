CREATE TYPE "public"."knowledge_summary_mode" AS ENUM('auto', 'manual', 'off');--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "summary_mode" "knowledge_summary_mode" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "summary_stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "summary_content_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "summary_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "summary_model" varchar(128);--> statement-breakpoint
CREATE INDEX "knowledge_text_summary_stale_idx" ON "base_knowledge_text" USING btree ("updated_at") WHERE "base_knowledge_text"."summary_stale" = true;