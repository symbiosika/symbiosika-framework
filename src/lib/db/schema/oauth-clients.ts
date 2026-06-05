/**
 * Schema for OAuth2 / OIDC clients (third-party integrations).
 *
 * A client belongs to a tenant and is created by a tenant admin. The
 * `client_secret` is shown exactly once at creation and stored only as a hash
 * (SHA-256, like `api_tokens`). Public clients (PKCE, no secret) keep
 * `client_secret_hash` NULL.
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

export const oauthClients = pgBaseTable(
  "oauth_clients",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(), // owner tenant
    clientId: text("client_id").notNull(), // public identifier
    clientSecretHash: text("client_secret_hash"), // SHA-256; NULL = public client (PKCE only)
    clientName: varchar("client_name", { length: 255 }).notNull(),
    clientType: varchar("client_type", { length: 16 })
      .notNull()
      .default("confidential"), // "public" | "confidential"
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    grantTypes: jsonb("grant_types")
      .$type<string[]>()
      .notNull()
      .default(["authorization_code", "refresh_token"]),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]), // allowed scopes
    tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", {
      length: 32,
    })
      .notNull()
      .default("client_secret_post"), // "none" | "client_secret_post" | "client_secret_basic"
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    disabledAt: timestamp("disabled_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("oauth_clients_client_id_idx").on(t.clientId),
    index("oauth_clients_tenant_id_idx").on(t.tenantId),
  ]
);

export type OauthClientsSelect = typeof oauthClients.$inferSelect;
export type OauthClientsInsert = typeof oauthClients.$inferInsert;

export const oauthClientsSelectSchema = createSelectSchema(oauthClients);
export const oauthClientsInsertSchema = createInsertSchema(oauthClients);
export const oauthClientsUpdateSchema = createUpdateSchema(oauthClients);
