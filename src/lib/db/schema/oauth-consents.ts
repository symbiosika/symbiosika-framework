/**
 * Schema for persisted user consent.
 *
 * Remembers that a user granted a client a set of scopes, so the consent screen
 * is skipped on subsequent authorize calls. A request for scopes beyond the
 * stored set triggers re-consent. Revoking access removes the row.
 */
import { sql } from "drizzle-orm";
import {
  uuid,
  timestamp,
  text,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import { users } from "./users";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

export const oauthConsents = pgBaseTable(
  "oauth_consents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    clientId: text("client_id").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(), // granted scopes
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("oauth_consents_user_client_idx").on(t.userId, t.clientId),
    index("oauth_consents_user_id_idx").on(t.userId),
  ]
);

export type OauthConsentsSelect = typeof oauthConsents.$inferSelect;
export type OauthConsentsInsert = typeof oauthConsents.$inferInsert;

export const oauthConsentsSelectSchema = createSelectSchema(oauthConsents);
export const oauthConsentsInsertSchema = createInsertSchema(oauthConsents);
export const oauthConsentsUpdateSchema = createUpdateSchema(oauthConsents);
