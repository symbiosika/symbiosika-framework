CREATE TABLE "base_tenant_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text,
	"value_json" jsonb,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_tenant_settings" ADD CONSTRAINT "base_tenant_settings_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_settings_tenant_id_key_unique" ON "base_tenant_settings" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "tenant_settings_tenant_id_idx" ON "base_tenant_settings" USING btree ("tenant_id");