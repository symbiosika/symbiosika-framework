import { sql } from "drizzle-orm";
import {
  pgEnum,
  text,
  uuid,
  index,
  integer,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { tenants, users } from "./users";
import { pgBaseTable } from ".";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

export const webhookTypeEnum = pgEnum("webhook_type", ["n8n"]);
export const webhookMethodEnum = pgEnum("webhook_method", ["POST", "GET"]);

/** Allowed values for the (text) auth_mode column; validated in code. */
export const WEBHOOK_AUTH_MODES = ["hmac", "headers", "none"] as const;
export type WebhookAuthMode = (typeof WEBHOOK_AUTH_MODES)[number];

// Table for webhooks. Webhooks are used to send notifications to external services.
export const webhooks = pgBaseTable(
  "webhooks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .references(() => users.id, {
        onDelete: "cascade",
      })
      .notNull(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, {
        onDelete: "cascade",
      })
      .notNull(),
    tenantWide: boolean("tenant_wide").notNull().default(false),
    // Whether this webhook is active. Disabled webhooks are kept but never
    // fired by the event dispatcher (and skipped for manual triggering).
    enabled: boolean("enabled").notNull().default(true),
    name: text("name").notNull(),
    type: webhookTypeEnum("type").notNull(), // 'n8n'
    // The event this webhook subscribes to. Free text validated against the
    // code-side registry in lib/webhooks/events.ts (was a pgEnum; widened to
    // text so a new event is a registry entry, not a schema migration).
    event: text("event").notNull(),
    webhookUrl: text("webhook_url").notNull(),
    method: webhookMethodEnum("method").notNull().default("POST"),
    headers: jsonb("headers").default({}).notNull(),
    // How outgoing deliveries authenticate themselves to the receiver:
    //  - 'hmac'    : sign the body (HMAC-SHA256) using `signingSecret`
    //  - 'headers' : rely solely on the static custom `headers` (e.g. n8n key)
    //  - 'none'    : send unauthenticated (not recommended)
    authMode: text("auth_mode").notNull().default("hmac"),
    // AES-encrypted HMAC signing secret (never stored or returned in clear).
    // Null when authMode != 'hmac'. Encrypted via lib/crypt/aes.
    signingSecret: text("signing_secret"),
    // Key version the signingSecret was encrypted with (for AES key rotation).
    signingSecretKeyVersion: integer("signing_secret_key_version"),
    meta: jsonb("meta").default({}).notNull(), // additional data for the webhook
    createdAt: timestamp("created_at", { mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (webhooks) => [
    index("webhooks_tenant_id_idx").on(webhooks.tenantId),
    uniqueIndex("webhooks_name_tenant_id_idx").on(
      webhooks.name,
      webhooks.webhookUrl,
      webhooks.tenantId,
      webhooks.event,
      webhooks.type
    ),
  ]
);

export const webhooksRelations = relations(webhooks, ({ one }) => ({
  tenant: one(tenants, {
    fields: [webhooks.tenantId],
    references: [tenants.id],
  }),
}));

export type WebhookType = "n8n";
export type WebhookSelect = typeof webhooks.$inferSelect;
export type WebhookInsert = typeof webhooks.$inferInsert;

export const webhookSchema = createSelectSchema(webhooks);
export const newWebhookSchema = createInsertSchema(webhooks);
export const updateWebhookSchema = createUpdateSchema(webhooks);
