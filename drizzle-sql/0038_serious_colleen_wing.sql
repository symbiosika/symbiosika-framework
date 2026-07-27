CREATE TABLE "base_knowledge_agent_instructions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "base_knowledge_agent_instructions_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
DROP INDEX "knowledge_text_agent_instructions_idx";--> statement-breakpoint
ALTER TABLE "base_knowledge_agent_instructions" ADD CONSTRAINT "base_knowledge_agent_instructions_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_agent_instructions" ADD CONSTRAINT "base_knowledge_agent_instructions_updated_by_base_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."base_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" DROP COLUMN "is_agent_instructions";