ALTER TABLE "base_connections" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "base_connections" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "base_connections" ADD CONSTRAINT "base_connections_name_unique" UNIQUE("name");