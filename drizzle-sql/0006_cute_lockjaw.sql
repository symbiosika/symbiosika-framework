CREATE TYPE "public"."message_type" AS ENUM('info', 'warning', 'error');--> statement-breakpoint
CREATE TABLE "base_user_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"message" text NOT NULL,
	"message_type" "message_type" DEFAULT 'info' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"confirmed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "base_user_messages" ADD CONSTRAINT "base_user_messages_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_messages_user_id_idx" ON "base_user_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_messages_confirmed_at_idx" ON "base_user_messages" USING btree ("confirmed_at");--> statement-breakpoint
CREATE INDEX "user_messages_created_at_idx" ON "base_user_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_messages_message_type_idx" ON "base_user_messages" USING btree ("message_type");