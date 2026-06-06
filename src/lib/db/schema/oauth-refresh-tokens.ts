/**
 * Schema for OAuth2 refresh tokens with rotation + reuse-detection.
 *
 * Only the SHA-256 hash is stored. Tokens of one grant share a `family_id`;
 * on rotation the old token's `rotated_to` points at the successor. Re-using an
 * already-rotated token indicates theft → the whole family is revoked.
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
import { tenants, users } from "./users";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

export const oauthRefreshTokens = pgBaseTable(
  "oauth_refresh_tokens",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tokenHash: text("token_hash").notNull(), // SHA-256
    familyId: uuid("family_id").notNull(), // for reuse-detection
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    rotatedTo: uuid("rotated_to"), // successor row (NULL = current)
    revokedAt: timestamp("revoked_at", { mode: "string" }),
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("oauth_refresh_tokens_token_hash_idx").on(t.tokenHash),
    index("oauth_refresh_tokens_family_id_idx").on(t.familyId),
    index("oauth_refresh_tokens_user_id_idx").on(t.userId),
    index("oauth_refresh_tokens_expires_at_idx").on(t.expiresAt),
  ]
);

export type OauthRefreshTokensSelect = typeof oauthRefreshTokens.$inferSelect;
export type OauthRefreshTokensInsert = typeof oauthRefreshTokens.$inferInsert;

export const oauthRefreshTokensSelectSchema =
  createSelectSchema(oauthRefreshTokens);
export const oauthRefreshTokensInsertSchema =
  createInsertSchema(oauthRefreshTokens);
export const oauthRefreshTokensUpdateSchema =
  createUpdateSchema(oauthRefreshTokens);
