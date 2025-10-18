import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  timestamp,
  uuid,
  varchar,
  integer,
  pgEnum,
  text,
} from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import { organisations } from "./users";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

// Enum for the type of file source
export const logLevelEnum = pgEnum("log_level", [
  "debug",
  "info",
  "warn",
  "error",
]);

export const appLogs = pgBaseTable(
  "app_logs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    level: logLevelEnum("level").notNull(),
    source: varchar("source", { length: 100 }).notNull(), // Application component or service name
    category: varchar("category", { length: 50 }).notNull(), // e.g., 'security', 'performance', 'user-action'
    sessionId: uuid("session_id"), // Optional a session id. For debugging sessions
    organisationId: uuid("organisation_id").references(() => organisations.id, {
      onDelete: "cascade",
    }), // optional, if the log is related to an organisation
    message: text("message").notNull(),
    metadata: jsonb("metadata").default("{}"), // Additional structured data
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("app_logs_level_idx").on(table.level),
    index("app_logs_category_idx").on(table.category),
    index("app_logs_source_idx").on(table.source),
    index("app_logs_created_at_idx").on(table.createdAt),
    index("app_logs_version_idx").on(table.version),
    index("app_logs_organisation_id_idx").on(table.organisationId),
  ]
);

export type AppLogsSelect = typeof appLogs.$inferSelect;
export type AppLogsInsert = typeof appLogs.$inferInsert;

export const appLogsSelectSchema = createSelectSchema(appLogs);
export const appLogsInsertSchema = createInsertSchema(appLogs);
export const appLogsUpdateSchema = createUpdateSchema(appLogs);
