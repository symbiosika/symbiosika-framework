-- Make e-mail identity case-insensitive.
--
-- Until now `unique_email` was a plain btree over `base_users.email` (type
-- `text`), so Postgres compared addresses byte for byte and accepted
-- `Max@example.com` alongside `max@example.com` as two separate accounts for
-- one mailbox. The same held for `unique_invitation` on
-- `base_tenant_invitations`.
--
-- Two steps: canonicalise the values that are already stored, then add unique
-- indexes over `lower(email)` so the database rejects the next attempt.
--
-- The byte-wise indexes are intentionally left in place: `ON CONFLICT` needs a
-- unique index matching its target list and Drizzle can only name columns
-- there, so the upserts in lib/auth/hanko.ts and
-- lib/usermanagement/invitations.ts have nothing to point at otherwise. Unique
-- lower-cased values imply unique raw values, so they add no restriction.
--
-- PREREQUISITE: this migration fails if rows already differ only in case — the
-- UPDATE below hits the existing byte-wise unique index. Resolve those rows
-- first; see docs/framework/case-insensitive-email.md for the queries that find
-- them. Failing here is deliberate: which of two duplicate accounts keeps its
-- data is not a decision a migration can make.

UPDATE "base_users" SET "email" = lower("email") WHERE "email" <> lower("email");--> statement-breakpoint
UPDATE "base_tenant_invitations" SET "email" = lower("email") WHERE "email" <> lower("email");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_invitation_lower" ON "base_tenant_invitations" USING btree (lower("email"),"tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_email_lower" ON "base_users" USING btree (lower("email"));
