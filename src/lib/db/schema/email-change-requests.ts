/**
 * Schema for pending e-mail change requests.
 *
 * Changing the address of an existing account is a two-step operation: the
 * request is stored here (it does NOT touch `users.email`) and only becomes
 * effective once the owner of the NEW mailbox clicks the verification link
 * that was sent there. This proves the new address exists and belongs to the
 * requester before it becomes the account's identity.
 *
 * Only the SHA-256 hash of the confirmation token is stored, never the
 * plaintext — a leaked database dump must not hand out working confirmation
 * links (same rule as `email_login_codes`).
 */
import { sql } from "drizzle-orm";
import { uuid, timestamp, text, index, uniqueIndex } from "drizzle-orm/pg-core";
import { pgBaseTable } from ".";
import { users } from "./users";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

export const emailChangeRequests = pgBaseTable(
  "email_change_requests",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The address the user wants to switch to, already normalized
    // (lib/utils/email.ts). Intentionally NOT unique: two users may have an
    // open request for the same address, the first one to confirm wins and the
    // other one fails the availability re-check at confirmation time.
    newEmail: text("new_email").notNull(),
    // The address the account had when the request was created. Kept so the
    // confirmation can detect a change that happened in the meantime and so
    // the old address can be notified.
    oldEmail: text("old_email").notNull(),
    tokenHash: text("token_hash").notNull(), // SHA-256 of the confirmation token
    expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),
    consumedAt: timestamp("consumed_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("email_change_requests_token_hash_idx").on(t.tokenHash),
    index("email_change_requests_user_id_idx").on(t.userId),
    index("email_change_requests_expires_at_idx").on(t.expiresAt),
  ]
);

export type EmailChangeRequestsSelect = typeof emailChangeRequests.$inferSelect;
export type EmailChangeRequestsInsert = typeof emailChangeRequests.$inferInsert;

export const emailChangeRequestsSelectSchema =
  createSelectSchema(emailChangeRequests);
export const emailChangeRequestsInsertSchema =
  createInsertSchema(emailChangeRequests);
export const emailChangeRequestsUpdateSchema =
  createUpdateSchema(emailChangeRequests);
