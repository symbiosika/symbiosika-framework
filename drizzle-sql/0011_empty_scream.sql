DELETE FROM "base_connections";--> statement-breakpoint
DELETE FROM "base_server_keys";--> statement-breakpoint

ALTER TABLE "base_connections" DROP CONSTRAINT "base_connections_client_id_base_server_keys_id_fk";
--> statement-breakpoint
DROP INDEX "connections_client_id_idx";--> statement-breakpoint
DROP INDEX "connections_client_id_unique_idx";--> statement-breakpoint
ALTER TABLE "base_connections" ADD COLUMN "remote_connection_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_name_unique_idx" ON "base_connections" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_remote_connection_id_unique_idx" ON "base_connections" USING btree ("tenant_id","remote_connection_id");--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "client_id";