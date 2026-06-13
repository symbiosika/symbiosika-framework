CREATE TABLE "base_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text,
	"client_name" varchar(255) NOT NULL,
	"client_type" varchar(16) DEFAULT 'confidential' NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"grant_types" jsonb DEFAULT '["authorization_code","refresh_token"]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_endpoint_auth_method" varchar(32) DEFAULT 'client_secret_post' NOT NULL,
	"created_by" uuid,
	"disabled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_oauth_auth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid,
	"redirect_uri" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" varchar(8) DEFAULT 'S256' NOT NULL,
	"nonce" text,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_oauth_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid,
	"scopes" jsonb NOT NULL,
	"rotated_to" uuid,
	"revoked_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_oauth_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_email_login_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"purpose" varchar(32) DEFAULT 'oauth_login' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_oauth_clients" ADD CONSTRAINT "base_oauth_clients_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_oauth_clients" ADD CONSTRAINT "base_oauth_clients_created_by_base_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."base_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_oauth_auth_codes" ADD CONSTRAINT "base_oauth_auth_codes_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_oauth_auth_codes" ADD CONSTRAINT "base_oauth_auth_codes_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_oauth_refresh_tokens" ADD CONSTRAINT "base_oauth_refresh_tokens_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_oauth_refresh_tokens" ADD CONSTRAINT "base_oauth_refresh_tokens_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_oauth_consents" ADD CONSTRAINT "base_oauth_consents_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_client_id_idx" ON "base_oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_clients_tenant_id_idx" ON "base_oauth_clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_auth_codes_code_hash_idx" ON "base_oauth_auth_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "oauth_auth_codes_expires_at_idx" ON "base_oauth_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_refresh_tokens_token_hash_idx" ON "base_oauth_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_family_id_idx" ON "base_oauth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_user_id_idx" ON "base_oauth_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_expires_at_idx" ON "base_oauth_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_consents_user_client_idx" ON "base_oauth_consents" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE INDEX "oauth_consents_user_id_idx" ON "base_oauth_consents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_login_codes_email_idx" ON "base_email_login_codes" USING btree ("email");--> statement-breakpoint
CREATE INDEX "email_login_codes_expires_at_idx" ON "base_email_login_codes" USING btree ("expires_at");