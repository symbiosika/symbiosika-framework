/**
 * Schema for passwordless email login codes (OTP).
 *
 * Used inside the OAuth authorize flow ("not logged in" path): a 6-digit code
 * is sent by email and entered in the same browser window (a magic *link* would
 * break the flow's state/PKCE). Only the SHA-256 hash is stored; max 5 attempts,
 * single-use, ~10min lifetime.
 */
import { sql } from "drizzle-orm";
import {
  uuid,
  timestamp,
  text,
  varchar,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

export const emailLoginCodes = pgBaseTable(
  "email_login_codes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(), // SHA-256 of the 6-digit code
    purpose: varchar("purpose", { length: 32 }).notNull().default("oauth_login"),
    attempts: integer("attempts").notNull().default(0), // invalidate after max
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    consumedAt: timestamp("consumed_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("email_login_codes_email_idx").on(t.email),
    index("email_login_codes_expires_at_idx").on(t.expiresAt),
  ]
);

export type EmailLoginCodesSelect = typeof emailLoginCodes.$inferSelect;
export type EmailLoginCodesInsert = typeof emailLoginCodes.$inferInsert;

export const emailLoginCodesSelectSchema = createSelectSchema(emailLoginCodes);
export const emailLoginCodesInsertSchema = createInsertSchema(emailLoginCodes);
export const emailLoginCodesUpdateSchema = createUpdateSchema(emailLoginCodes);
