CREATE TYPE "public"."tenant_origin" AS ENUM('local', 'remote');--> statement-breakpoint
CREATE TYPE "public"."connection_role" AS ENUM('leading', 'following');--> statement-breakpoint
ALTER TABLE "base_tenants" DROP CONSTRAINT "tenants_name_idx";--> statement-breakpoint
ALTER TABLE "base_tenants" ADD COLUMN "origin" "tenant_origin" DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "base_connections" ADD COLUMN "remote_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "base_connections" ADD COLUMN "role" "connection_role" DEFAULT 'leading' NOT NULL;--> statement-breakpoint
ALTER TABLE "base_connections" ADD COLUMN "status" "connection_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_name_local_unique_idx" ON "base_tenants" USING btree ("name") WHERE "base_tenants"."origin" = 'local';