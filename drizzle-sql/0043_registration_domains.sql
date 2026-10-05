CREATE TABLE "base_registration_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"domain" text NOT NULL,
	"tenant_id" uuid,
	"role" "tenant_member_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_registration_domains" ADD CONSTRAINT "base_registration_domains_tenant_id_base_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."base_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_registration_domain" ON "base_registration_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "registration_domains_tenant_id_idx" ON "base_registration_domains" USING btree ("tenant_id");