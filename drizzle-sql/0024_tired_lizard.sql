ALTER TABLE "base_knowledge_text" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD COLUMN "version_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_created_by_base_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."base_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_updated_by_base_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."base_users"("id") ON DELETE set null ON UPDATE no action;