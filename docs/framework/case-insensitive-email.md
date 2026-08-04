# Case-insensitive e-mail identity

An e-mail address is a user identity in this framework, so it must not depend on
capitalisation. `Max.Mustermann@example.com` and `max.mustermann@example.com` are
one mailbox at every mail provider in practice; treating them as two accounts
only ever produces duplicates.

Two layers enforce this:

**Application.** `normalizeEmail` (`src/lib/utils/email.ts`) trims and
lower-cases. Every read of and write to `users.email` and
`tenantInvitations.email` goes through it — registration, magic link, e-mail
OTP, OAuth2/social login, Hanko, passkeys, `getUserByEmail`, `updateUser`, and
invitation create/accept. Normalising on **read** matters as much as on write: a
lookup that misses an existing account because of capitalisation is what makes
the next step create a second one.

**Database.** Unique indexes over `lower(email)`:

- `unique_email_lower` on `base_users`
- `unique_invitation_lower` on `base_tenant_invitations` (with `tenant_id`)

These are the guarantee. A code path that forgets to normalise now fails loudly
instead of silently duplicating a user.

The older byte-wise `unique_email` / `unique_invitation` indexes are kept
deliberately. `ON CONFLICT` needs a unique index matching its target list, and
Drizzle's `target` option only accepts columns, never expressions — so the
upserts in `src/lib/auth/hanko.ts` and `src/lib/usermanagement/invitations.ts`
would have nothing to point at. Unique lower-cased values imply unique raw
values, so these indexes constrain nothing beyond the `lower()` ones.

## Before migrating: find and resolve existing duplicates

Migration `0040_case_insensitive_email_uniqueness` lower-cases the stored values
before creating the indexes. That `UPDATE` **fails** if two rows differ only in
case, because it would collide on the existing byte-wise unique index. This is
intentional: which of two duplicate accounts keeps its tasks, memberships and
history is a business decision, not something a migration can decide.

Find the affected users:

```sql
SELECT lower(email)         AS canonical_email,
       count(*)             AS rows,
       array_agg(id      ORDER BY created_at) AS user_ids,
       array_agg(email   ORDER BY created_at) AS variants,
       array_agg(created_at ORDER BY created_at) AS created
FROM base_users
GROUP BY lower(email)
HAVING count(*) > 1
ORDER BY canonical_email;
```

Same for invitations (duplicates are per tenant):

```sql
SELECT tenant_id,
       lower(email)       AS canonical_email,
       count(*)           AS rows,
       array_agg(id     ORDER BY created_at) AS invitation_ids,
       array_agg(email  ORDER BY created_at) AS variants
FROM base_tenant_invitations
GROUP BY tenant_id, lower(email)
HAVING count(*) > 1
ORDER BY tenant_id, canonical_email;
```

Rows that are merely stored in mixed case but have no counterpart need no
attention — the migration rewrites them on its own. To see them anyway:

```sql
SELECT id, email, created_at
FROM base_users
WHERE email <> lower(email)
ORDER BY created_at;
```

Once every group above returns nothing, run the migration.
