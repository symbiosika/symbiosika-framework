DROP INDEX "connections_client_id_initiated_by_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "connections_client_id_unique_idx" ON "base_connections" USING btree ("client_id");