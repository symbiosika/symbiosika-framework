import { sql } from "drizzle-orm";
import { text, uuid, varchar, timestamp, jsonb } from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-valibot";

export const userSettings = pgBaseTable(
  "user_settings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    key: varchar("key", { length: 255 }).notNull().unique(),
    value: text("value"),
    valueJson: jsonb("value_json").$type<Record<string, unknown>>(),
    description: text("description"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  }
);

export type UserSettingsSelect = typeof userSettings.$inferSelect;
export type UserSettingsInsert = typeof userSettings.$inferInsert;

export const userSettingsSelectSchema = createSelectSchema(userSettings);
export const userSettingsInsertSchema = createInsertSchema(userSettings);
export const userSettingsUpdateSchema = createUpdateSchema(userSettings);
