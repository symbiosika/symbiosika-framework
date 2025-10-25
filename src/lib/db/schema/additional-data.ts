import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  timestamp,
  uuid,
  varchar,
  integer,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { tenants, teams, users } from "./users";
import { pgBaseTable } from ".";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

// Table for user specific data
export const userSpecificData = pgBaseTable(
  "user_specific_data",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 50 }).notNull(),
    version: integer("version").notNull().default(0),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.userId, table.key),
    index("user_data_type_idx").on(table.key),
    index("user_data_created_at_idx").on(table.createdAt),
    index("user_data_version_idx").on(table.version),
  ]
);

export type UserSpecificDataSelect = typeof userSpecificData.$inferSelect;
export type UserSpecificDataInsert = typeof userSpecificData.$inferInsert;

export const userSpecificDataSelectSchema =
  createSelectSchema(userSpecificData);
export const userSpecificDataInsertSchema =
  createInsertSchema(userSpecificData);
export const userSpecificDataUpdateSchema =
  createUpdateSchema(userSpecificData);

// Table for application specific data. This is data that does not belong to a user or a group or an tenant.
export const appSpecificData = pgBaseTable(
  "app_specific_data",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    key: varchar("key", { length: 100 }).notNull().unique(),
    version: integer("version").notNull().default(0),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("app_data_created_at_idx").on(table.createdAt),
    index("app_data_version_idx").on(table.version),
  ]
);

export type AppSpecificDataSelect = typeof appSpecificData.$inferSelect;
export type AppSpecificDataInsert = typeof appSpecificData.$inferInsert;

export const appSpecificDataSelectSchema = createSelectSchema(appSpecificData);
export const appSpecificDataInsertSchema = createInsertSchema(appSpecificData);
export const appSpecificDataUpdateSchema = createUpdateSchema(appSpecificData);

export const userSpecificDataRelations = relations(
  userSpecificData,
  ({ one }) => ({
    user: one(users, {
      fields: [userSpecificData.userId],
      references: [users.id],
    }),
  })
);

// Table for tenant specific data
export const tenantSpecificData = pgBaseTable(
  "tenant_specific_data",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: varchar("category", { length: 100 }).notNull(),
    version: integer("version").notNull().default(0),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.tenantId, table.key),
    index("tenant_data_key_idx").on(table.key),
    index("tenant_data_created_at_idx").on(table.createdAt),
    index("tenant_data_version_idx").on(table.version),
  ]
);

export type OrganisationSpecificDataSelect =
  typeof tenantSpecificData.$inferSelect;
export type OrganisationSpecificDataInsert =
  typeof tenantSpecificData.$inferInsert;

export const tenantSpecificDataSelectSchema = createSelectSchema(
  tenantSpecificData
);
export const tenantSpecificDataInsertSchema = createInsertSchema(
  tenantSpecificData
);
export const tenantSpecificDataUpdateSchema = createUpdateSchema(
  tenantSpecificData
);

// Table for team specific data

export const teamSpecificData = pgBaseTable(
  "team_specific_data",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 50 }).notNull(),
    version: integer("version").notNull().default(0),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.teamId, table.key),
    index("team_data_key_idx").on(table.key),
    index("team_data_created_at_idx").on(table.createdAt),
    index("team_data_version_idx").on(table.version),
  ]
);

export type TeamSpecificDataSelect = typeof teamSpecificData.$inferSelect;
export type TeamSpecificDataInsert = typeof teamSpecificData.$inferInsert;

export const teamSpecificDataSelectSchema =
  createSelectSchema(teamSpecificData);
export const teamSpecificDataInsertSchema =
  createInsertSchema(teamSpecificData);
export const teamSpecificDataUpdateSchema =
  createUpdateSchema(teamSpecificData);

export const teamSpecificDataRelations = relations(
  teamSpecificData,
  ({ one }) => ({
    team: one(teams, {
      fields: [teamSpecificData.teamId],
      references: [teams.id],
    }),
  })
);
