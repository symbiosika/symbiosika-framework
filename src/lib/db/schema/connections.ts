import { sql } from "drizzle-orm";
import {
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import { organisations, users } from "./users";
import { relations } from "drizzle-orm";
import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-valibot";

export const connectionStatusEnum = pgEnum("connection_status", [
  "pending",
  "active",
  "disconnected",
  "revoked",
]);

export const initiatedByEnum = pgEnum("initiated_by", ["client", "server"]);

export const authenticationTypeEnum = pgEnum("authentication_type", [
  "none",
  "api_token",
  "basic_auth",
]);

export const connections = pgBaseTable(
  "connections",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }),
    remoteUrl: text("remote_url"),
    initiatedBy: initiatedByEnum("initiated_by").notNull().default("client"),
    status: connectionStatusEnum("status").notNull().default("pending"),
    // Local key pair (this server/app instance)
    localPublicKey: text("local_public_key").notNull(),
    localPrivateKey: text("local_private_key").notNull(),
    localPrivateKeyType: varchar("local_private_key_type", { length: 255 })
      .notNull()
      .default("aes-256-cbc"),
    // Remote public key (client when initiatedBy=client)
    remotePublicKey: text("remote_public_key"),
    // Remote server details (for server-to-server connections)
    remoteOrganisationId: uuid("remote_organisation_id"),
    remoteConnectionId: uuid("remote_connection_id"),
    // Authentication for remote server
    authenticationType: authenticationTypeEnum("authentication_type")
      .notNull()
      .default("none"),
    remoteCredentials: text("remote_credentials"), // encrypted API token or username:password
    remoteCredentialsType: varchar("remote_credentials_type", { length: 255 })
      .default("aes-256-cbc"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    lastConnectedAt: timestamp("last_connected_at", { mode: "string" }),
    meta: jsonb("meta").default({}).notNull(),
  },
  (t) => [
    index("connections_org_idx").on(t.organisationId),
    index("connections_status_idx").on(t.status),
    index("connections_remote_url_idx").on(t.remoteUrl),
    uniqueIndex("connections_name_org_idx").on(t.organisationId, t.name),
  ]
);

export const connectionsRelations = relations(connections, ({ one }) => ({
  organisation: one(organisations, {
    fields: [connections.organisationId],
    references: [organisations.id],
  }),
  createdBy: one(users, {
    fields: [connections.createdByUserId],
    references: [users.id],
  }),
}));

export type ConnectionsSelect = typeof connections.$inferSelect;
export type ConnectionsInsert = typeof connections.$inferInsert;

export const connectionsSelectSchema = createSelectSchema(connections);
export const connectionsInsertSchema = createInsertSchema(connections);
export const connectionsUpdateSchema = createUpdateSchema(connections);


