import { sql, relations } from "drizzle-orm";
import {
  text,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import { tenants } from "./users";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-valibot";

/**
 * Per-tenant (organisation) key-value settings.
 *
 * The tenant-level counterpart to `user_settings`: instead of belonging to a
 * single user, a row belongs to a tenant and is shared by every member of that
 * tenant. Reading is open to any tenant member; writing is restricted to tenant
 * admins/owners (enforced by the route middleware, see
 * `routes/tenant/[tenantId]/settings`).
 *
 * Typical uses are organisation-wide preferences such as branding colours or
 * feature toggles. Values may be stored as a plain string (`value`) or as a
 * JSON object (`valueJson`).
 */
export const tenantSettings = pgBaseTable(
  "tenant_settings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 255 }).notNull(),
    value: text("value"),
    valueJson: jsonb("value_json").$type<Record<string, unknown>>(),
    description: text("description"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // A setting key is unique *per tenant*, not globally.
    uniqueIndex("tenant_settings_tenant_id_key_unique").on(t.tenantId, t.key),
    index("tenant_settings_tenant_id_idx").on(t.tenantId),
  ]
);

export const tenantSettingsRelations = relations(tenantSettings, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tenantSettings.tenantId],
    references: [tenants.id],
  }),
}));

export type TenantSettingsSelect = typeof tenantSettings.$inferSelect;
export type TenantSettingsInsert = typeof tenantSettings.$inferInsert;

export const tenantSettingsSelectSchema = createSelectSchema(tenantSettings);
export const tenantSettingsInsertSchema = createInsertSchema(tenantSettings);
export const tenantSettingsUpdateSchema = createUpdateSchema(tenantSettings);
