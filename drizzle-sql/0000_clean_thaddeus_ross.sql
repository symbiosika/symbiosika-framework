CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "public"."magic_link_purpose" AS ENUM('login', 'email_verification', 'password_reset');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('info', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."permission_type" AS ENUM('regex');--> statement-breakpoint
CREATE TYPE "public"."team_member_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."tenant_invitation_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."tenant_member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."user_provider" AS ENUM('local', 'google', 'microsoft');--> statement-breakpoint
CREATE TYPE "public"."file_source_type" AS ENUM('db', 'local', 'url', 'text', 'finetuning', 'plugin', 'external');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."webhook_event" AS ENUM('chat-output', 'tool');--> statement-breakpoint
CREATE TYPE "public"."webhook_method" AS ENUM('POST', 'GET');--> statement-breakpoint
CREATE TYPE "public"."webhook_type" AS ENUM('n8n');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('pending', 'active', 'disconnected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."initiated_by" AS ENUM('local', 'remote');--> statement-breakpoint
CREATE TABLE "base_group_permissions" (
	"group_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "base_group_permissions_group_id_permission_id_pk" PRIMARY KEY("group_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "base_invitation_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"code" text NOT NULL,
	"tenant_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"max_uses" integer DEFAULT -1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_magic_link_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"purpose" "magic_link_purpose" DEFAULT 'login' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_path_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"category" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"type" "permission_type" DEFAULT 'regex' NOT NULL,
	"method" varchar(10) NOT NULL,
	"path_expression" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "unique_category_name" UNIQUE("category","name")
);
--> statement-breakpoint
CREATE TABLE "base_sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_team_members" (
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"role" "team_member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "base_team_members_user_id_team_id_pk" PRIMARY KEY("user_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "base_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"meta" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "teams_name_idx" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "base_tenant_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" "tenant_member_role" DEFAULT 'member' NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_tenant_members" (
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" "tenant_member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "base_tenant_members_user_id_tenant_id_pk" PRIMARY KEY("user_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "base_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_name_idx" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "base_user_group_members" (
	"user_id" uuid NOT NULL,
	"user_groups_id" uuid NOT NULL,
	CONSTRAINT "base_user_group_members_user_id_user_groups_id_pk" PRIMARY KEY("user_id","user_groups_id")
);
--> statement-breakpoint
CREATE TABLE "base_user_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"message" text NOT NULL,
	"message_type" "message_type" DEFAULT 'info' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"confirmed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "base_user_permission_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"meta" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"tenant_id" uuid
);
--> statement-breakpoint
CREATE TABLE "base_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "user_provider" DEFAULT 'local' NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"password" text,
	"salt" text,
	"image" text,
	"firstname" varchar(255) NOT NULL,
	"surname" varchar(255) NOT NULL,
	"phone_number" varchar(255),
	"phone_number_verified" boolean DEFAULT false NOT NULL,
	"phone_number_as_number" bigint,
	"phone_pin_number" varchar(6),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ext_user_id" text DEFAULT '' NOT NULL,
	"meta" jsonb,
	"profile_image" "bytea",
	"profile_image_name" varchar(255),
	"profile_image_content_type" varchar(255),
	"last_tenant_id" uuid
);
--> statement-breakpoint
CREATE TABLE "base_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(255) NOT NULL,
	"reference_id" uuid,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"label" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"type" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_reference_name_idx" UNIQUE("reference","name")
);
--> statement-breakpoint
CREATE TABLE "base_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bucket" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"file_type" varchar(255) NOT NULL,
	"extension" varchar(255) NOT NULL,
	"file" "bytea" NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "base_app_specific_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(100) NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "base_app_specific_data_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "base_team_specific_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"key" varchar(50) NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "base_team_specific_data_team_id_key_unique" UNIQUE("team_id","key")
);
--> statement-breakpoint
CREATE TABLE "base_tenant_specific_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" varchar(100) NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "base_tenant_specific_data_tenant_id_category_unique" UNIQUE("tenant_id","category")
);
--> statement-breakpoint
CREATE TABLE "base_user_specific_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" varchar(50) NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "base_user_specific_data_user_id_key_unique" UNIQUE("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "base_knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_entry_id" uuid NOT NULL,
	"text" text NOT NULL,
	"header" varchar(1000),
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"embedding_model" varchar(255) DEFAULT '' NOT NULL,
	"dimensions" integer DEFAULT 0 NOT NULL,
	"text_embedding_1536" vector(1536),
	"text_embedding_1024" vector(1024),
	"meta" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "knowledge_chunks_embedding_required" CHECK (text_embedding_1536 IS NOT NULL OR text_embedding_1024 IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "base_knowledge_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid,
	"user_id" uuid,
	"user_owned" boolean DEFAULT false NOT NULL,
	"knowledge_group_id" uuid,
	"parentId" uuid,
	"name" varchar(1000) NOT NULL,
	"description" text,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"version_text" text DEFAULT '1' NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "knowledge_entry_description_max_length" CHECK (length(description) <= 10000)
);
--> statement-breakpoint
CREATE TABLE "base_knowledge_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_knowledge_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_wide_access" boolean DEFAULT false NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_group_name_org_idx" UNIQUE("name","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "base_knowledge_group_team_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_group_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_group_team_assignment_unique" UNIQUE("knowledge_group_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "base_knowledge_text" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_wide" boolean DEFAULT false NOT NULL,
	"team_id" uuid,
	"user_id" uuid,
	"text" text NOT NULL,
	"title" varchar(1000) DEFAULT '' NOT NULL,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "knowledge_text_text_min_length" CHECK (length(text) > 3)
);
--> statement-breakpoint
CREATE TABLE "base_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_app_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level" "log_level" NOT NULL,
	"source" varchar(100) NOT NULL,
	"category" varchar(50) NOT NULL,
	"session_id" uuid,
	"tenant_id" uuid,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}',
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tenant_wide" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"type" "webhook_type" NOT NULL,
	"event" "webhook_event" NOT NULL,
	"webhook_url" text NOT NULL,
	"method" "webhook_method" DEFAULT 'POST' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_server_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"private_key" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_server_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scopes" jsonb NOT NULL,
	"last_used" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"auto_delete" boolean DEFAULT false NOT NULL,
	CONSTRAINT "api_tokens_token_idx" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "base_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"remote_url" text,
	"remote_connection_id" text,
	"remote_public_key" text,
	"initiated_by" "initiated_by" DEFAULT 'local' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_connected_at" timestamp,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_group_permissions" ADD CONSTRAINT "base_group_permissions_group_id_base_user_permission_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."base_user_permission_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_group_permissions" ADD CONSTRAINT "base_group_permissions_permission_id_base_path_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."base_path_permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_invitation_codes" ADD CONSTRAINT "base_invitation_codes_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_magic_link_sessions" ADD CONSTRAINT "base_magic_link_sessions_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_path_permissions" ADD CONSTRAINT "base_path_permissions_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_sessions" ADD CONSTRAINT "base_sessions_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_team_members" ADD CONSTRAINT "base_team_members_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_team_members" ADD CONSTRAINT "base_team_members_team_id_base_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."base_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_teams" ADD CONSTRAINT "base_teams_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_tenant_invitations" ADD CONSTRAINT "base_tenant_invitations_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_tenant_members" ADD CONSTRAINT "base_tenant_members_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_tenant_members" ADD CONSTRAINT "base_tenant_members_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_user_group_members" ADD CONSTRAINT "base_user_group_members_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_user_group_members" ADD CONSTRAINT "base_user_group_members_user_groups_id_base_user_permission_groups_id_fk" FOREIGN KEY ("user_groups_id") REFERENCES "public"."base_user_permission_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_user_messages" ADD CONSTRAINT "base_user_messages_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_user_permission_groups" ADD CONSTRAINT "base_user_permission_groups_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_users" ADD CONSTRAINT "base_users_last_tenant_id_base_tenants_id_fk" FOREIGN KEY ("last_tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_secrets" ADD CONSTRAINT "base_secrets_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_files" ADD CONSTRAINT "base_files_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_team_specific_data" ADD CONSTRAINT "base_team_specific_data_team_id_base_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."base_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_tenant_specific_data" ADD CONSTRAINT "base_tenant_specific_data_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_user_specific_data" ADD CONSTRAINT "base_user_specific_data_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_chunks" ADD CONSTRAINT "base_knowledge_chunks_knowledge_entry_id_base_knowledge_entry_id_fk" FOREIGN KEY ("knowledge_entry_id") REFERENCES "public"."base_knowledge_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_entry" ADD CONSTRAINT "base_knowledge_entry_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_entry" ADD CONSTRAINT "base_knowledge_entry_team_id_base_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."base_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_entry" ADD CONSTRAINT "base_knowledge_entry_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_entry" ADD CONSTRAINT "base_knowledge_entry_knowledge_group_id_base_knowledge_group_id_fk" FOREIGN KEY ("knowledge_group_id") REFERENCES "public"."base_knowledge_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_entry" ADD CONSTRAINT "base_knowledge_entry_parentId_base_knowledge_entry_id_fk" FOREIGN KEY ("parentId") REFERENCES "public"."base_knowledge_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_filters" ADD CONSTRAINT "base_knowledge_filters_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_group" ADD CONSTRAINT "base_knowledge_group_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_group" ADD CONSTRAINT "base_knowledge_group_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_group_team_assignments" ADD CONSTRAINT "base_knowledge_group_team_assignments_knowledge_group_id_base_knowledge_group_id_fk" FOREIGN KEY ("knowledge_group_id") REFERENCES "public"."base_knowledge_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_group_team_assignments" ADD CONSTRAINT "base_knowledge_group_team_assignments_team_id_base_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."base_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_team_id_base_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."base_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_knowledge_text" ADD CONSTRAINT "base_knowledge_text_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_jobs" ADD CONSTRAINT "base_jobs_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_jobs" ADD CONSTRAINT "base_jobs_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_app_logs" ADD CONSTRAINT "base_app_logs_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_webhooks" ADD CONSTRAINT "base_webhooks_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_webhooks" ADD CONSTRAINT "base_webhooks_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_api_tokens" ADD CONSTRAINT "base_api_tokens_user_id_base_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."base_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_api_tokens" ADD CONSTRAINT "base_api_tokens_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_connections" ADD CONSTRAINT "base_connections_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_permissions_group_id_idx" ON "base_group_permissions" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_permissions_permission_id_idx" ON "base_group_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_invitation_code" ON "base_invitation_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "invitation_codes_tenant_id_idx" ON "base_invitation_codes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "invitation_codes_expires_at_idx" ON "base_invitation_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_token" ON "base_magic_link_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "magic_link_sessions_user_id_idx" ON "base_magic_link_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "magic_link_sessions_expires_at_idx" ON "base_magic_link_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "permissions_method_idx" ON "base_path_permissions" USING btree ("method");--> statement-breakpoint
CREATE INDEX "permissions_type_idx" ON "base_path_permissions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "base_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "base_sessions" USING btree ("expires");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_invitation" ON "base_tenant_invitations" USING btree ("email","tenant_id");--> statement-breakpoint
CREATE INDEX "invitations_status_idx" ON "base_tenant_invitations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invitations_created_at_idx" ON "base_tenant_invitations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "base_tenant_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "tenant_members_user_id_idx" ON "base_tenant_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tenant_members_tenant_id_idx" ON "base_tenant_members" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "user_messages_user_id_idx" ON "base_user_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_messages_confirmed_at_idx" ON "base_user_messages" USING btree ("confirmed_at");--> statement-breakpoint
CREATE INDEX "user_messages_created_at_idx" ON "base_user_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_messages_message_type_idx" ON "base_user_messages" USING btree ("message_type");--> statement-breakpoint
CREATE INDEX "user_permission_groups_name_idx" ON "base_user_permission_groups" USING btree ("name");--> statement-breakpoint
CREATE INDEX "user_permission_groups_created_at_idx" ON "base_user_permission_groups" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "base_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_email" ON "base_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_phone_number" ON "base_users" USING btree ("phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_phone_number_as_number" ON "base_users" USING btree ("phone_number_as_number");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "base_users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "users_updated_at_idx" ON "base_users" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "users_email_verified_idx" ON "base_users" USING btree ("email_verified");--> statement-breakpoint
CREATE INDEX "secrets_idx" ON "base_secrets" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "secrets_ref_idx" ON "base_secrets" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "secrets_ref_id_idx" ON "base_secrets" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "secrets_name_idx" ON "base_secrets" USING btree ("name");--> statement-breakpoint
CREATE INDEX "secrets_type_idx" ON "base_secrets" USING btree ("type");--> statement-breakpoint
CREATE INDEX "files_id_idx" ON "base_files" USING btree ("id");--> statement-breakpoint
CREATE INDEX "files_bucket_name_idx" ON "base_files" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "files_created_at_idx" ON "base_files" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "files_updated_at_idx" ON "base_files" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "files_name_idx" ON "base_files" USING btree ("name");--> statement-breakpoint
CREATE INDEX "files_expires_at_idx" ON "base_files" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "app_data_created_at_idx" ON "base_app_specific_data" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "app_data_version_idx" ON "base_app_specific_data" USING btree ("version");--> statement-breakpoint
CREATE INDEX "team_data_key_idx" ON "base_team_specific_data" USING btree ("key");--> statement-breakpoint
CREATE INDEX "team_data_created_at_idx" ON "base_team_specific_data" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "team_data_version_idx" ON "base_team_specific_data" USING btree ("version");--> statement-breakpoint
CREATE INDEX "tenant_data_key_idx" ON "base_tenant_specific_data" USING btree ("category");--> statement-breakpoint
CREATE INDEX "tenant_data_created_at_idx" ON "base_tenant_specific_data" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tenant_data_version_idx" ON "base_tenant_specific_data" USING btree ("version");--> statement-breakpoint
CREATE INDEX "user_data_type_idx" ON "base_user_specific_data" USING btree ("key");--> statement-breakpoint
CREATE INDEX "user_data_created_at_idx" ON "base_user_specific_data" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_data_version_idx" ON "base_user_specific_data" USING btree ("version");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_knowledge_entry_id_idx" ON "base_knowledge_chunks" USING btree ("knowledge_entry_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_created_at_idx" ON "base_knowledge_chunks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_header_idx" ON "base_knowledge_chunks" USING btree ("header");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledgeentry_name_idx" ON "base_knowledge_entry" USING btree ("name","parentId","tenant_id","team_id","user_id","version");--> statement-breakpoint
CREATE INDEX "knowledgeentry_created_at_idx" ON "base_knowledge_entry" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "knowledgeentry_updated_at_idx" ON "base_knowledge_entry" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "knowledgeentry_deleted_at_idx" ON "base_knowledge_entry" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "knowledgeentry_tenant_id_idx" ON "base_knowledge_entry" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "knowledge_entry_team_id_idx" ON "base_knowledge_entry" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "knowledge_entry_user_id_idx" ON "base_knowledge_entry" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_filters_name_type_unique" ON "base_knowledge_filters" USING btree ("name","category");--> statement-breakpoint
CREATE INDEX "knowledge_filters_category_name_idx" ON "base_knowledge_filters" USING btree ("category","name");--> statement-breakpoint
CREATE INDEX "knowledge_group_tenant_id_idx" ON "base_knowledge_group" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "knowledge_group_user_id_idx" ON "base_knowledge_group" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "knowledge_group_team_assignment_knowledge_group_id_idx" ON "base_knowledge_group_team_assignments" USING btree ("knowledge_group_id");--> statement-breakpoint
CREATE INDEX "knowledge_group_team_assignment_team_id_idx" ON "base_knowledge_group_team_assignments" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_created_at_idx" ON "base_knowledge_text" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "knowledge_text_updated_at_idx" ON "base_knowledge_text" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "knowledge_text_deleted_at_idx" ON "base_knowledge_text" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "knowledge_text_title_idx" ON "base_knowledge_text" USING btree ("title");--> statement-breakpoint
CREATE INDEX "knowledge_text_tenant_id_idx" ON "base_knowledge_text" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_team_id_idx" ON "base_knowledge_text" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "knowledge_text_user_id_idx" ON "base_knowledge_text" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "jobs_created_at_idx" ON "base_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_user_id_idx" ON "base_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "base_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "app_logs_level_idx" ON "base_app_logs" USING btree ("level");--> statement-breakpoint
CREATE INDEX "app_logs_category_idx" ON "base_app_logs" USING btree ("category");--> statement-breakpoint
CREATE INDEX "app_logs_source_idx" ON "base_app_logs" USING btree ("source");--> statement-breakpoint
CREATE INDEX "app_logs_created_at_idx" ON "base_app_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "app_logs_version_idx" ON "base_app_logs" USING btree ("version");--> statement-breakpoint
CREATE INDEX "app_logs_tenant_id_idx" ON "base_app_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webhooks_tenant_id_idx" ON "base_webhooks" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_name_tenant_id_idx" ON "base_webhooks" USING btree ("name","webhook_url","tenant_id","event","type");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_key" ON "base_server_settings" USING btree ("key");--> statement-breakpoint
CREATE INDEX "api_tokens_user_id_idx" ON "base_api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_tokens_tenant_id_idx" ON "base_api_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "api_tokens_auto_delete_idx" ON "base_api_tokens" USING btree ("auto_delete");--> statement-breakpoint
CREATE INDEX "connections_tenant_idx" ON "base_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "connections_remote_url_idx" ON "base_connections" USING btree ("remote_url");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_name_initiated_by_unique_idx" ON "base_connections" USING btree ("tenant_id","name","initiated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_remote_connection_id_initiated_by_unique_idx" ON "base_connections" USING btree ("tenant_id","remote_connection_id","initiated_by");