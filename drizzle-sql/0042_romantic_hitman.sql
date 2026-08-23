CREATE TABLE "base_email_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"new_email" text NOT NULL,
	"old_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_email_change_requests" ADD CONSTRAINT "base_email_change_requests_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_change_requests_token_hash_idx" ON "base_email_change_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_change_requests_user_id_idx" ON "base_email_change_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_change_requests_expires_at_idx" ON "base_email_change_requests" USING btree ("expires_at");