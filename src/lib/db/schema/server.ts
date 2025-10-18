import { sql } from "drizzle-orm";
import { text, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";

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
