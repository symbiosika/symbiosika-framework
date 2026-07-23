ALTER TABLE "base_knowledge_entry" DROP CONSTRAINT IF EXISTS "base_knowledge_entry_knowledge_group_id_base_knowledge_group_id_fk";--> statement-breakpoint
ALTER TABLE "base_knowledge_entry" DROP COLUMN IF EXISTS "knowledge_group_id";--> statement-breakpoint
DROP TABLE IF EXISTS "base_knowledge_group_team_assignments" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "base_knowledge_group" CASCADE;
