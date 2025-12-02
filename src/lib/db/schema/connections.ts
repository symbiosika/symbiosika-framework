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
import { tenants, users } from "./users";
import { serverKeys } from "./server";
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

export const initiatedByEnum = pgEnum("initiated_by", ["local", "remote"]);

export const connections = pgBaseTable(
  "connections",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, {
        onDelete: "cascade",
      })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    remoteUrl: text("remote_url"),
    remoteConnectionId: text("remote_connection_id"),
    remotePublicKey: text("remote_public_key"),
    initiatedBy: initiatedByEnum("initiated_by").notNull().default("local"),
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
    index("connections_tenant_idx").on(t.tenantId),
    index("connections_remote_url_idx").on(t.remoteUrl),
    uniqueIndex("connections_tenant_name_initiated_by_unique_idx").on(t.tenantId, t.name, t.initiatedBy),
    uniqueIndex("connections_tenant_remote_connection_id_initiated_by_unique_idx").on(
      t.tenantId,
      t.remoteConnectionId,
      t.initiatedBy
    ),
  ]
);

export const connectionsRelations = relations(connections, ({ one }) => ({
  tenant: one(tenants, {
    fields: [connections.tenantId],
    references: [tenants.id],
  }),
}));

export type ConnectionsSelect = typeof connections.$inferSelect;
export type ConnectionsInsert = typeof connections.$inferInsert;

export const connectionsSelectSchema = createSelectSchema(connections);
export const connectionsInsertSchema = createInsertSchema(connections);
export const connectionsUpdateSchema = createUpdateSchema(connections);
