--> Existing rows have no user association and cannot be attributed to a user,
--> so they are removed before the non-nullable user_id column is added.
DELETE FROM "base_user_settings";--> statement-breakpoint
ALTER TABLE "base_user_settings" DROP CONSTRAINT "base_user_settings_key_unique";--> statement-breakpoint
ALTER TABLE "base_user_settings" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "base_user_settings" ADD CONSTRAINT "base_user_settings_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_settings_user_id_key_unique" ON "base_user_settings" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "user_settings_user_id_idx" ON "base_user_settings" USING btree ("user_id");