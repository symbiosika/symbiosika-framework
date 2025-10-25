CREATE TYPE "public"."authentication_type" AS ENUM('none', 'api_token', 'basic_auth');--> statement-breakpoint
ALTER TABLE "base_connections" ADD COLUMN "remote_organisation_id" uuid;--> statement-breakpoint
ALTER TABLE "base_connections" ADD COLUMN "remote_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "base_connections" ADD COLUMN "authentication_type" "authentication_type" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "base_connections" ADD COLUMN "remote_credentials" text;--> statement-breakpoint
ALTER TABLE "base_connections" ADD COLUMN "remote_credentials_type" varchar(255) DEFAULT 'aes-256-cbc';