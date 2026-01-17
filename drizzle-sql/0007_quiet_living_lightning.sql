-- Step 1: Create history table
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

-- Step 2: Drop old indexes
DROP INDEX IF EXISTS "knowledge_text_document_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "knowledge_text_document_latest_idx";--> statement-breakpoint

-- Step 3: Copy all NON-LATEST versions to history table
-- For each document, copy all versions except the latest one
INSERT INTO "base_knowledge_text_history" (
	"knowledge_text_id",
	"tenant_id",
	"tenant_wide",
	"team_id",
	"user_id",
	"parent_id",
	"text",
	"title",
	"meta",
	"hidden",
	"created_at"
)
SELECT 
	-- Link to the latest version's ID (which will become the main ID)
	latest.id as knowledge_text_id,
	old_version.tenant_id,
	old_version.tenant_wide,
	old_version.team_id,
	old_version.user_id,
	old_version.parent_id,
	old_version.text,
	old_version.title,
	old_version.meta,
	old_version.hidden,
	old_version.created_at
FROM "base_knowledge_text" old_version
INNER JOIN "base_knowledge_text" latest 
	ON old_version.document_id = latest.document_id 
	AND latest.is_latest = true
WHERE old_version.is_latest = false
ORDER BY old_version.document_id, old_version.created_at;
--> statement-breakpoint

-- Step 4: Delete all NON-LATEST versions from knowledge_text
-- Keep only the latest version of each document
DELETE FROM "base_knowledge_text"
WHERE is_latest = false;
--> statement-breakpoint

-- Step 5: Fix parent_id references on remaining (latest) entries
-- Convert parent_id from documentId to the actual id of the latest version
UPDATE "base_knowledge_text" kt1
SET parent_id = kt2.id
FROM "base_knowledge_text" kt2
WHERE kt1.parent_id IS NOT NULL
  AND kt1.parent_id = kt2.document_id;
--> statement-breakpoint

-- Step 6: Set parent_id to NULL for entries that don't have a valid parent after conversion
UPDATE "base_knowledge_text"
SET parent_id = NULL
WHERE parent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "base_knowledge_text" kt2 
    WHERE kt2.id = "base_knowledge_text".parent_id
  );
--> statement-breakpoint

-- Step 7: Add foreign key constraints for history table
ALTER TABLE "base_knowledge_text_history" ADD CONSTRAINT "base_knowledge_text_history_knowledge_text_id_base_knowledge_text_id_fk" FOREIGN KEY ("knowledge_text_id") REFERENCES "public"."base_knowledge_text"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD CONSTRAINT "base_knowledge_text_history_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD CONSTRAINT "base_knowledge_text_history_team_id_base_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."base_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text_history" ADD CONSTRAINT "base_knowledge_text_history_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Step 8: Add foreign key for parent_id on knowledge_text (now safe because we fixed the references)
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_parent_id_base_knowledge_text_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."base_knowledge_text"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Step 9: Create indexes for history table
CREATE INDEX "knowledge_text_history_knowledge_text_id_idx" ON "base_knowledge_text_history" USING btree ("knowledge_text_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_history_tenant_id_idx" ON "base_knowledge_text_history" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_history_created_at_idx" ON "base_knowledge_text_history" USING btree ("created_at");--> statement-breakpoint

-- Step 10: Drop old columns (document_id, version, is_latest) from knowledge_text
ALTER TABLE "base_knowledge_text" DROP COLUMN IF EXISTS "document_id";--> statement-breakpoint
ALTER TABLE "base_knowledge_text" DROP COLUMN IF EXISTS "version";--> statement-breakpoint
ALTER TABLE "base_knowledge_text" DROP COLUMN IF EXISTS "is_latest";
