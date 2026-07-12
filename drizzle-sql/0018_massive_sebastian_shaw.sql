CREATE TABLE "base_knowledge_text_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid,
	"target_title" varchar(1000) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_text_link_source_target_unique" UNIQUE("source_id","target_title")
);
--> statement-breakpoint
ALTER TABLE "base_knowledge_text_link" ADD CONSTRAINT "base_knowledge_text_link_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_link" ADD CONSTRAINT "base_knowledge_text_link_source_id_base_knowledge_text_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."base_knowledge_text"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_link" ADD CONSTRAINT "base_knowledge_text_link_target_id_base_knowledge_text_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."base_knowledge_text"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_text_link_source_id_idx" ON "base_knowledge_text_link" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_link_target_id_idx" ON "base_knowledge_text_link" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_link_tenant_target_title_idx" ON "base_knowledge_text_link" USING btree ("tenant_id","target_title");--> statement-breakpoint
CREATE INDEX "knowledge_text_fts_idx" ON "base_knowledge_text" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("text", '')));