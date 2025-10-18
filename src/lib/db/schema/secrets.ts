/**
 * Schema definition for secrets that needs to be stored in the database
 */

import { sql } from "drizzle-orm";
import {
  uuid,
  timestamp,
  text,
  unique,
  index,
  varchar,
} from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import { organisations } from "./users";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

// Secrets
export const secrets = pgBaseTable(
  "secrets",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reference: varchar("reference", { length: 255 }).notNull(),
    referenceId: uuid("reference_id"),
    organisationId: uuid("organisation_id")
      .references(() => organisations.id, {
        onDelete: "cascade",
      })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    value: text("value").notNull(),
    type: varchar("type", { length: 255 }).notNull(), // encryption type like aes-256-cbc
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (secrets) => [
    unique("secrets_reference_name_idx").on(secrets.reference, secrets.name),
    index("secrets_idx").on(secrets.referenceId),
    index("secrets_ref_idx").on(secrets.reference),
    index("secrets_ref_id_idx").on(secrets.referenceId),
    index("secrets_name_idx").on(secrets.name),
    index("secrets_type_idx").on(secrets.type),
  ]
);

export type SecretsSelect = typeof secrets.$inferSelect;
export type SecretsInsert = typeof secrets.$inferInsert;

export const secretsSelectSchema = createSelectSchema(secrets);
export const secretsInsertSchema = createInsertSchema(secrets);
export const secretsUpdateSchema = createUpdateSchema(secrets);
