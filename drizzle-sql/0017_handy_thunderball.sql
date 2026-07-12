CREATE TYPE "public"."knowledge_block_type" AS ENUM('markdown', 'html');--> statement-breakpoint
CREATE TYPE "public"."knowledge_content_mode" AS ENUM('text', 'blocks');--> statement-breakpoint
CREATE TABLE "base_knowledge_text_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_text_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" "knowledge_block_type" DEFAULT 'markdown' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"position" varchar(64) NOT NULL,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "content_mode" "knowledge_content_mode" DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "position" varchar(64);--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "embedding_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "knowledge_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD COLUMN "content_mode" "knowledge_content_mode" DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD COLUMN "blocks" jsonb;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_block" ADD CONSTRAINT "base_knowledge_text_block_knowledge_text_id_base_knowledge_text_id_fk" FOREIGN KEY ("knowledge_text_id") REFERENCES "public"."base_knowledge_text"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_block" ADD CONSTRAINT "base_knowledge_text_block_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_text_block_page_position_idx" ON "base_knowledge_text_block" USING btree ("knowledge_text_id","position");--> statement-breakpoint
CREATE INDEX "knowledge_text_block_knowledge_text_id_idx" ON "base_knowledge_text_block" USING btree ("knowledge_text_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_block_tenant_id_idx" ON "base_knowledge_text_block" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_knowledge_entry_id_base_knowledge_entry_id_fk" FOREIGN KEY ("knowledge_entry_id") REFERENCES "public"."base_knowledge_entry"("id") ON DELETE set null ON UPDATE no action;