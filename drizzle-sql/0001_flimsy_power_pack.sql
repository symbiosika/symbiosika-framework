DROP INDEX "connections_org_idx";--> statement-breakpoint
DROP INDEX "connections_org_remote_org_idx";--> statement-breakpoint
CREATE INDEX "connections_tenant_idx" ON "base_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_remote_tenant_idx" ON "base_connections" USING btree ("tenant_id","remote_tenant_id");