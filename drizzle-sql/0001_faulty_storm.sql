CREATE TYPE "public"."connection_status" AS ENUM('pending', 'active', 'disconnected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."initiated_by" AS ENUM('client', 'server');--> statement-breakpoint
CREATE TABLE "base_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" varchar(255),
	"remote_url" text,
	"initiated_by" "initiated_by" DEFAULT 'client' NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"local_public_key" text NOT NULL,
	"local_private_key" text NOT NULL,
	"local_private_key_type" varchar(255) DEFAULT 'aes-256-cbc' NOT NULL,
	"remote_public_key" text,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_connected_at" timestamp,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_connections" ADD CONSTRAINT "base_connections_organisation_id_base_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."base_organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_connections" ADD CONSTRAINT "base_connections_created_by_user_id_base_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."base_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_org_idx" ON "base_connections" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "connections_status_idx" ON "base_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "connections_remote_url_idx" ON "base_connections" USING btree ("remote_url");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_name_org_idx" ON "base_connections" USING btree ("organisation_id","name");