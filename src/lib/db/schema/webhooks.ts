import { sql } from "drizzle-orm";
import {
  pgEnum,
  text,
  uuid,
  index,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organisations, users } from "./users";
import { pgBaseTable } from ".";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

export const webhookTypeEnum = pgEnum("webhook_type", ["n8n"]);
export const webhookEventEnum = pgEnum("webhook_event", [
  "chat-output",
  "tool",
]);
export const webhookMethodEnum = pgEnum("webhook_method", ["POST", "GET"]);

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
    organisationId: uuid("organisation_id")
      .references(() => organisations.id, {
        onDelete: "cascade",
      })
      .notNull(),
    organisationWide: boolean("organisation_wide").notNull().default(false),
    name: text("name").notNull(),
    type: webhookTypeEnum("type").notNull(), // 'n8n'
    event: webhookEventEnum("event").notNull(), // 'chat-output' or 'tool'
    webhookUrl: text("webhook_url").notNull(),
    method: webhookMethodEnum("method").notNull().default("POST"),
    headers: jsonb("headers").default({}).notNull(),
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
    index("webhooks_organisation_id_idx").on(webhooks.organisationId),
    uniqueIndex("webhooks_name_organisation_id_idx").on(
      webhooks.name,
      webhooks.webhookUrl,
      webhooks.organisationId,
      webhooks.event,
      webhooks.type
    ),
  ]
);

export const webhooksRelations = relations(webhooks, ({ one }) => ({
  organisation: one(organisations, {
    fields: [webhooks.organisationId],
    references: [organisations.id],
  }),
}));

export type WebhookType = "n8n";
export type WebhookSelect = typeof webhooks.$inferSelect;
export type WebhookInsert = typeof webhooks.$inferInsert;

export const webhookSchema = createSelectSchema(webhooks);
export const newWebhookSchema = createInsertSchema(webhooks);
export const updateWebhookSchema = createUpdateSchema(webhooks);
