ALTER TABLE "base_knowledge_text" ADD COLUMN "page_type" varchar(64);--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "status" varchar(64);--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "verified_by" uuid;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "owner_team_id" uuid;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "valid_until" timestamp;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_verified_by_base_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."base_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_owner_user_id_base_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."base_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_owner_team_id_base_teams_id_fk" FOREIGN KEY ("owner_team_id") REFERENCES "public"."base_teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_supersedes_id_base_knowledge_text_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."base_knowledge_text"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_text_page_type_idx" ON "base_knowledge_text" USING btree ("tenant_id","page_type");--> statement-breakpoint
CREATE INDEX "knowledge_text_status_idx" ON "base_knowledge_text" USING btree ("tenant_id","status");