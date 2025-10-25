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
    lastConnectedAt: timestamp("last_connected_at", { mode: "string" }),
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
