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
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-valibot";

export const connectionStatusEnum = pgEnum("connection_status", [
  "pending",
  "active",
  "disconnected",
  "revoked",
]);

export const initiatedByEnum = pgEnum("initiated_by", ["client", "server"]);

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
    localPublicKey: text("local_public_key").notNull(),
    localPrivateKey: text("local_private_key").notNull(),
    localPrivateKeyType: varchar("local_private_key_type", { length: 255 })
      .notNull()
      .default("aes-256-cbc"),
    remotePublicKey: text("remote_public_key"),
    remoteOrganisationId: uuid("remote_organisation_id"),
    remoteConnectionId: uuid("remote_connection_id"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    meta: jsonb("meta").default({}).notNull(),
  },
  (t) => [
    index("connections_org_idx").on(t.organisationId),
    index("connections_remote_url_idx").on(t.remoteUrl),
    // only one connection per organisation and remote organisation
    uniqueIndex("connections_org_remote_org_idx").on(
      t.organisationId,
      t.remoteOrganisationId
    ),
  ]
);

export const connectionsRelations = relations(connections, ({ one }) => ({
  organisation: one(organisations, {
    fields: [connections.organisationId],
    references: [organisations.id],
  }),
}));

export type ConnectionsSelect = typeof connections.$inferSelect;
export type ConnectionsInsert = typeof connections.$inferInsert;

export const connectionsSelectSchema = createSelectSchema(connections);
export const connectionsInsertSchema = createInsertSchema(connections);
export const connectionsUpdateSchema = createUpdateSchema(connections);

/**
 * Connections sessions - stores active WebSocket connections between servers
 */
export const connectionSessions = pgBaseTable(
  "connection_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    remoteSessionId: uuid("remote_session_id"),
    status: varchar("status", { length: 50 }).notNull().default("active"),
    encryptionAlgorithm: varchar("encryption_algorithm", { length: 255 })
      .notNull()
      .default("aes-256-cbc"),
    metadata: jsonb("metadata").default({}).notNull(),
    lastHeartbeat: timestamp("last_heartbeat", { mode: "string" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("connection_sessions_connection_idx").on(t.connectionId),
    index("connection_sessions_status_idx").on(t.status),
  ]
);

export const connectionSessionsRelations = relations(
  connectionSessions,
  ({ one }) => ({
    connection: one(connections, {
      fields: [connectionSessions.connectionId],
      references: [connections.id],
    }),
  })
);

export type ConnectionSessionsSelect = typeof connectionSessions.$inferSelect;
export type ConnectionSessionsInsert = typeof connectionSessions.$inferInsert;

export const connectionSessionsSelectSchema = createSelectSchema(connectionSessions);
export const connectionSessionsInsertSchema = createInsertSchema(connectionSessions);
export const connectionSessionsUpdateSchema = createUpdateSchema(connectionSessions);