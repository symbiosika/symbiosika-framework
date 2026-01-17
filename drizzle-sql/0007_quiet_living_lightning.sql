CREATE TABLE "base_knowledge_text_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_text_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_wide" boolean DEFAULT false NOT NULL,
	"team_id" uuid,
	"user_id" uuid,
	"parent_id" uuid,
	"text" text DEFAULT '' NOT NULL,
	"title" varchar(1000) DEFAULT '' NOT NULL,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "knowledge_text_document_id_idx";--> statement-breakpoint
DROP INDEX "knowledge_text_document_latest_idx";--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD CONSTRAINT "base_knowledge_text_history_knowledge_text_id_base_knowledge_text_id_fk" FOREIGN KEY ("knowledge_text_id") REFERENCES "public"."base_knowledge_text"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD CONSTRAINT "base_knowledge_text_history_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD CONSTRAINT "base_knowledge_text_history_team_id_base_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."base_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD CONSTRAINT "base_knowledge_text_history_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_text_history_knowledge_text_id_idx" ON "base_knowledge_text_history" USING btree ("knowledge_text_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_history_tenant_id_idx" ON "base_knowledge_text_history" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_history_created_at_idx" ON "base_knowledge_text_history" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_parent_id_base_knowledge_text_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."base_knowledge_text"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" DROP COLUMN "document_id";--> statement-breakpoint
ALTER TABLE "base_knowledge_text" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "base_knowledge_text" DROP COLUMN "is_latest";