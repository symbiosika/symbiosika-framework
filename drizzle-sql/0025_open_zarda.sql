ALTER TYPE "public"."message_type" ADD VALUE 'success';--> statement-breakpoint
ALTER TABLE "base_user_messages" ADD COLUMN "meta" jsonb;