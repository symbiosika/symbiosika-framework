import { sql } from "drizzle-orm";
import { text, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-valibot";

export const serverSettings = pgBaseTable(
  "server_settings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("unique_key").on(t.key)]
);

export type ServerSettingsSelect = typeof serverSettings.$inferSelect;
export type ServerSettingsInsert = typeof serverSettings.$inferInsert;

export const serverKeys = pgBaseTable("server_keys", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  privateKey: text("private_key").notNull(),
  publicKey: text("public_key").notNull(),
  createdAt: timestamp("created_at", { mode: "string" })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "string" })
    .defaultNow()
    .notNull(),
});

export type ServerKeysSelect = typeof serverKeys.$inferSelect;
export type ServerKeysInsert = typeof serverKeys.$inferInsert;

export const serverKeysSelectSchema = createSelectSchema(serverKeys);
export const serverKeysInsertSchema = createInsertSchema(serverKeys);
export const serverKeysUpdateSchema = createUpdateSchema(serverKeys);
