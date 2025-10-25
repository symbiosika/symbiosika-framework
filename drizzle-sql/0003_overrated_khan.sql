CREATE TABLE "base_connection_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"remote_session_id" uuid,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"encryption_algorithm" varchar(255) DEFAULT 'aes-256-cbc' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_heartbeat" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_connections" DROP CONSTRAINT "base_connections_created_by_user_id_base_users_id_fk";
--> statement-breakpoint
DROP INDEX "connections_status_idx";--> statement-breakpoint
DROP INDEX "connections_name_org_idx";--> statement-breakpoint
ALTER TABLE "base_connection_sessions" ADD CONSTRAINT "base_connection_sessions_connection_id_base_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."base_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_sessions_connection_idx" ON "base_connection_sessions" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "connection_sessions_status_idx" ON "base_connection_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_org_remote_org_idx" ON "base_connections" USING btree ("organisation_id","remote_organisation_id");--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "authentication_type";--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "remote_credentials";--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "remote_credentials_type";--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "created_by_user_id";--> statement-breakpoint
ALTER TABLE "base_connections" DROP COLUMN "last_connected_at";--> statement-breakpoint
DROP TYPE "public"."authentication_type";