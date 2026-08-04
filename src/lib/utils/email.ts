/**
 * Canonical form of an e-mail address for identity purposes.
 *
 * An address is a *user identity* in this framework, and identities must not
 * depend on how someone happened to capitalise their mail when signing up,
 * being invited, or arriving via an OAuth provider. The domain part is
 * case-insensitive by specification (RFC 1035); the local part is technically
 * case-sensitive, but no mail provider in practice treats
 * `Max.Mustermann@…` and `max.mustermann@…` as different mailboxes. Keeping
 * them apart in our own tables therefore only ever produces duplicate
 * accounts, never a legitimate distinction.
 *
 * Every read of and write to `users.email` / `tenantInvitations.email` runs
 * through this function, and the database enforces the same rule via unique
 * indexes on `lower(email)` — so a path that forgets to normalise fails loudly
 * instead of silently creating a second account.
 */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();
