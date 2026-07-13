CREATE TABLE "base_knowledge_text_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"knowledge_text_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_text_file_page_file_unique" UNIQUE("knowledge_text_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "base_knowledge_text_file" ADD CONSTRAINT "base_knowledge_text_file_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_file" ADD CONSTRAINT "base_knowledge_text_file_knowledge_text_id_base_knowledge_text_id_fk" FOREIGN KEY ("knowledge_text_id") REFERENCES "public"."base_knowledge_text"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_file" ADD CONSTRAINT "base_knowledge_text_file_file_id_base_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."base_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_text_file_knowledge_text_id_idx" ON "base_knowledge_text_file" USING btree ("knowledge_text_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_file_file_id_idx" ON "base_knowledge_text_file" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_file_tenant_id_idx" ON "base_knowledge_text_file" USING btree ("tenant_id");