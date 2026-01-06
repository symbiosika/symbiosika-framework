ALTER TABLE "base_knowledge_text" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_parent_id_base_knowledge_text_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."base_knowledge_text"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_text_parent_id_idx" ON "base_knowledge_text" USING btree ("parent_id");