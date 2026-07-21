ALTER TABLE "base_webhooks" ALTER COLUMN "event" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "base_webhooks" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "base_webhooks" ADD COLUMN "auth_mode" text DEFAULT 'hmac' NOT NULL;--> statement-breakpoint
UPDATE "base_webhooks" SET "auth_mode" = 'headers';--> statement-breakpoint
ALTER TABLE "base_webhooks" ADD COLUMN "signing_secret" text;--> statement-breakpoint
ALTER TABLE "base_webhooks" ADD COLUMN "signing_secret_key_version" integer;--> statement-breakpoint
DROP TYPE "public"."webhook_event";