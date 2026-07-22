CREATE TYPE "public"."knowledge_access_level" AS ENUM('read', 'write');--> statement-breakpoint
ALTER TABLE "base_team_members" ADD COLUMN "knowledge_access" "knowledge_access_level" DEFAULT 'write' NOT NULL;--> statement-breakpoint
ALTER TABLE "base_tenant_members" ADD COLUMN "knowledge_access" "knowledge_access_level" DEFAULT 'write' NOT NULL;