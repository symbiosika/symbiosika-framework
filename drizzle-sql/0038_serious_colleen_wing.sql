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
-- Hand-written backfill (not generated): carry the content of any page a tenant
-- had flagged as its agent instructions into the new table before the flag is
-- dropped, otherwise the DROP COLUMN below would silently discard it. One row
-- per tenant, preferring an organisation-wide page over a team-scoped one and
-- the most recently updated among those. The source pages themselves are left
-- untouched — they stay ordinary wiki pages and merely lose the flag.
INSERT INTO "base_knowledge_agent_instructions" ("tenant_id", "content", "updated_by", "created_at", "updated_at")
SELECT DISTINCT ON (kt."tenant_id")
  kt."tenant_id", kt."text", kt."updated_by", kt."created_at", kt."updated_at"
FROM "base_knowledge_text" kt
WHERE kt."is_agent_instructions" = true
  AND kt."deleted_at" IS NULL
ORDER BY kt."tenant_id", (kt."team_id" IS NULL) DESC, kt."updated_at" DESC
ON CONFLICT ("tenant_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" DROP COLUMN "is_agent_instructions";