ALTER TABLE "base_user_settings" ALTER COLUMN "value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "base_user_settings" ADD COLUMN "value_json" jsonb;