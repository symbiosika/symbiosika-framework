import { sql, relations } from "drizzle-orm";
import {
  text,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import { users } from "./users";
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
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 255 }).notNull(),
    value: text("value"),
    valueJson: jsonb("value_json").$type<Record<string, unknown>>(),
    description: text("description"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // A setting key is unique *per user*, not globally.
    uniqueIndex("user_settings_user_id_key_unique").on(t.userId, t.key),
    index("user_settings_user_id_idx").on(t.userId),
  ]
);

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, {
    fields: [userSettings.userId],
    references: [users.id],
  }),
}));

export type UserSettingsSelect = typeof userSettings.$inferSelect;
export type UserSettingsInsert = typeof userSettings.$inferInsert;

export const userSettingsSelectSchema = createSelectSchema(userSettings);
export const userSettingsInsertSchema = createInsertSchema(userSettings);
export const userSettingsUpdateSchema = createUpdateSchema(userSettings);
