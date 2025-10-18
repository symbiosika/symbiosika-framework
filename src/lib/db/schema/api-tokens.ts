/**
 * Schema definition for API tokens
 */

import { sql } from "drizzle-orm";
import {
  uuid,
  timestamp,
  text,
  unique,
  index,
  varchar,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import { organisations, users } from "./users";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

// API Tokens
export const apiTokens = pgBaseTable(
  "api_tokens",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 255 }).notNull(),
    token: text("token").notNull(), // hashed token
    userId: uuid("user_id")
      .references(() => users.id, {
        onDelete: "cascade",
      })
      .notNull(), // user that created the token
    organisationId: uuid("organisation_id")
      .references(() => organisations.id, {
        onDelete: "cascade",
      })
      .notNull(), // organisation that the token belongs to
    scopes: jsonb("scopes").notNull(), // permissions of the token as json array
    lastUsed: timestamp("last_used", { mode: "string" }),
    expiresAt: timestamp("expires_at", { mode: "string" }), // optional: expiration date of the token
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    autoDelete: boolean("auto_delete").notNull().default(false),
  },
  (apiTokens) => [
    unique("api_tokens_token_idx").on(apiTokens.token),
    index("api_tokens_user_id_idx").on(apiTokens.userId),
    index("api_tokens_organisation_id_idx").on(apiTokens.organisationId),
    index("api_tokens_auto_delete_idx").on(apiTokens.autoDelete),
  ]
);

export type ApiTokensSelect = typeof apiTokens.$inferSelect;
export type ApiTokensInsert = typeof apiTokens.$inferInsert;

export const apiTokensSelectSchema = createSelectSchema(apiTokens);
export const apiTokensInsertSchema = createInsertSchema(apiTokens);
export const apiTokensUpdateSchema = createUpdateSchema(apiTokens);
