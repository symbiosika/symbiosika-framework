/**
 * Schema for OAuth2 authorization codes (ephemeral, single-use).
 *
 * Only the SHA-256 hash of the code is stored. Bound to client + redirect_uri,
 * carries the PKCE challenge and the OIDC `nonce`. Lifetime ~60s, consumed once.
 */
import { sql } from "drizzle-orm";
import {
  uuid,
  timestamp,
  text,
  varchar,
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

export const oauthAuthCodes = pgBaseTable(
  "oauth_auth_codes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    codeHash: text("code_hash").notNull(), // SHA-256 of the code
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    redirectUri: text("redirect_uri").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    codeChallenge: text("code_challenge").notNull(), // PKCE
    codeChallengeMethod: varchar("code_challenge_method", { length: 8 })
      .notNull()
      .default("S256"),
    nonce: text("nonce"), // OIDC nonce, echoed into id_token
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    consumedAt: timestamp("consumed_at", { mode: "string" }), // single-use guard
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("oauth_auth_codes_code_hash_idx").on(t.codeHash),
    index("oauth_auth_codes_expires_at_idx").on(t.expiresAt),
  ]
);

export type OauthAuthCodesSelect = typeof oauthAuthCodes.$inferSelect;
export type OauthAuthCodesInsert = typeof oauthAuthCodes.$inferInsert;

export const oauthAuthCodesSelectSchema = createSelectSchema(oauthAuthCodes);
export const oauthAuthCodesInsertSchema = createInsertSchema(oauthAuthCodes);
export const oauthAuthCodesUpdateSchema = createUpdateSchema(oauthAuthCodes);
