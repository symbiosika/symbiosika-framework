DELETE FROM "base_connections";

CREATE TABLE "base_server_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"private_key" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_connections" DROP CONSTRAINT "base_connections_name_unique";--> statement-breakpoint
DROP INDEX "connections_tenant_remote_tenant_idx";--> statement-breakpoint
ALTER TABLE "base_connections" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "base_connections" ADD COLUMN "client_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "base_connections" ADD CONSTRAINT "base_connections_client_id_base_server_keys_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."base_server_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_client_id_idx" ON "base_connections" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_client_id_initiated_by_unique_idx" ON "base_connections" USING btree ("client_id","initiated_by");--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "local_public_key";--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "local_private_key";--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "local_private_key_type";--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "remote_tenant_id";--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "remote_connection_id";