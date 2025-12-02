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
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 255 }).notNull().unique(),
    remoteUrl: text("remote_url"),
    initiatedBy: initiatedByEnum("initiated_by").notNull().default("local"),
    localPublicKey: text("local_public_key").notNull(),
    localPrivateKey: text("local_private_key").notNull(),
    localPrivateKeyType: varchar("local_private_key_type", { length: 255 })
      .notNull()
      .default("aes-256-cbc"),
    remotePublicKey: text("remote_public_key"),
    remoteTenantId: uuid("remote_tenant_id"),
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
    index("connections_tenant_idx").on(t.tenantId),
    index("connections_remote_url_idx").on(t.remoteUrl),
    // only one connection per tenant and remote tenant
    uniqueIndex("connections_tenant_remote_tenant_idx").on(
      t.tenantId,
      t.remoteTenantId,
      t.name
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
