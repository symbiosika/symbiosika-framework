# Built-in User Management

## Overview

The symbiosika-framework comes with a fully integrated user management system. As soon as you start a webserver with the framework, all essential features for managing users, organizations, teams, and invitations are available out of the box—including the necessary API routes. You do not need to implement your own user management: authentication, authorization, and all core endpoints are ready to use.

---

## API Route Prefix

All user management API routes are prefixed with `/api/v1/` by default. For example, the login endpoint is available at `/api/v1/user/login`.

---

## Authentication & Public User Endpoints

The following endpoints are available for user authentication and registration:

- **POST `/api/v1/user/login`**  
  Login with email and password (or magic link token). Returns a JWT token and user info.
  **Body:**
  ```json
  {
    "email": "user@example.com",
    "password": "yourPassword"
    // OR
    // "magicLinkToken": "..."
  }
  ```

- **POST `/api/v1/user/register`**  
  Register a new user account with email and password. Optionally sends a verification email.
  **Body:**
  ```json
  {
    "email": "user@example.com",
    "password": "yourPassword",
    "sendVerificationEmail": true
  }
  ```

- **GET `/api/v1/user/send-magic-link?email=...`**  
  Send a magic login link to the user's email address.
  **Query:** `?email=user@example.com`

- **GET `/api/v1/user/send-verification-email?email=...`**  
  Send a verification email to the user.
  **Query:** `?email=user@example.com`

- **GET `/api/v1/user/verify-email?token=...`**  
  Verify a user's email address using a token.
  **Query:** `?token=...`

- **GET `/api/v1/user/email-change/info?token=...`**  
  Read the details of a pending email change (which address is about to become
  the account's) **without** applying it. Used by the confirmation page.
  **Query:** `?token=...`

- **POST `/api/v1/user/email-change/confirm`**  
  Confirm a pending email change. This is the step that finally writes the new
  address to the account.
  **Body:**
  ```json
  {
    "token": "..."
  }
  ```

- **POST `/api/v1/user/forgot-password`**  
  Request a password reset email.
  **Body:**
  ```json
  {
    "email": "user@example.com"
  }
  ```

- **POST `/api/v1/user/reset-password`**  
  Set a new password using a reset token.
  **Body:**
  ```json
  {
    "token": "resetToken",
    "password": "newPassword"
  }
  ```

- **GET `/api/v1/user/invitation-code-needed`**  
  Check if an invitation code is required for registration.

- **POST `/api/v1/user/token-exchange`**  
  Exchange an API token for a short-lived JWT with specific scopes.
  **Body:**
  ```json
  {
    "token": "apiToken",
    "scopes": ["user:read", "user:write"]
  }
  ```

- **GET `/api/v1/user/oauth-providers`**  
  List available OAuth providers (`{ "google": bool, "microsoft": bool }`).
  A provider counts as available only when **both** its client id and its
  client secret are configured — a login page can use this to decide whether to
  offer the button at all.

- **GET `/api/v1/user/auth/:provider`**  
  Start the social login: redirects to the provider's sign-in page.
  **Query (optional):** `?redirectUrl=...` — where to send the user after a
  successful login. Only server-relative paths are accepted (no open redirect);
  the default is `oauthCallbackUrl` from `defineServer`.
  The `state` value and the PKCE verifier are pinned in a short-lived HttpOnly
  cookie (`oauth_login_tx`), so the callback can only be completed by the same
  browser that started the login.

- **GET `/api/v1/user/auth/:provider/callback`**  
  Finish the social login. Verifies `state`, exchanges the code (PKCE), resolves
  the account and **sets the normal auth cookies** (`jwt` HttpOnly +
  `jwt_present`) — the session token never travels through a URL. Then redirects
  to the target from the login transaction.
  **Query:** `?code=...&state=...` (or `?error=...` when the user cancels).
  Failures redirect to `loginUrl?error=oauth_unavailable|oauth_cancelled|oauth_failed`.
  When the address is unknown **and** the instance requires an invitation code,
  no account is created — see "Social sign-up with a required invitation code".

- **GET `/api/v1/user/oauth/pending-registration`**  
  The identity behind a social sign-up that is waiting for an invitation code,
  read from the `oauth_pending_registration` cookie:
  `{ "email", "provider", "firstname", "surname" }`. `401` when there is none
  (or it expired).

- **POST `/api/v1/user/oauth/complete-registration`**  
  Second attempt of that sign-up, now with a code. Creates the account for the
  identity in the cookie and sets the normal auth cookies.
  **Body:** `{ "invitationCode": "..." }`
  **Response:** `{ "user": {...}, "redirect": "/where/to/go" }`
  `400` for a missing/unknown code (retryable — the pending registration is
  kept), `401` when the pending registration is gone.

### Social sign-up with a required invitation code

A verified Microsoft / Google identity proves *who* somebody is, not that they
are allowed to use the instance. So when general invitation codes are active
(`invitation_codes` with `is_active = true`) and a social login arrives for an
address that has **no account and no pending tenant invitation**, the callback
does **not** create a user. Instead:

1. the verified profile is signed into a short-lived token (15 min, purpose
   `oauth_pending_registration`) and pinned in an HttpOnly cookie of the same
   name — so the provider round-trip does not have to be repeated, and the token
   never appears in a URL;
2. the browser is redirected to `oauthInvitationCodeUrl`
   (`defineServer`, default `/oauth-invitation-code.html`);
3. that page reads the identity from `GET /user/oauth/pending-registration`,
   asks for the invitation code and posts it to
   `POST /user/oauth/complete-registration`, which validates the code, creates
   the account and signs the user in — landing on the `redirectUrl` the login
   was started with.

A pending tenant invitation for the address counts as authorisation on its own
and skips the whole detour (same rule as the magic-link sign-up). If the code
carries a `tenant_id`, the new account joins that tenant — as its **owner** when
the tenant has no members yet, as a member otherwise, exactly like
`LocalAuth.register`.

The pending-registration token grants nothing by itself: it only states that
this server verified this identity minutes ago. Creating the account still
requires a valid invitation code, and a wrong code can be retried until the
token expires.

### Social login and existing accounts

An OAuth identity is resolved in this order:

1. **the provider's subject id** (`users.extUserId`) — Microsoft's `oid`,
   Google's `sub`. It is immutable, so the login keeps hitting the right account
   after the address was renamed in the directory. An empty id never matches
   (it is the column default on every local account), and a hit belonging to a
   *different* social provider is ignored — the id spaces are unrelated.
2. **the e-mail address** the provider just verified. `users.email` is unique,
   so one address is one account: a user created by a magic link (`provider:
   "local"`) can sign in with Microsoft or Google, and the subject id is
   **backfilled** onto that account so step 1 catches it from then on.
   Resolving by `email + provider` instead would try to insert a second row for
   an existing address, which the unique index rejects.
3. otherwise the address is registered on the spot (with `emailVerified: true`,
   pending organisation invitations accepted and the post-register actions run)
   — unless the instance requires an invitation code, see above.

The `provider` column keeps recording how the account was originally created
and gates nothing. A profile without a subject id is rejected.

A changed address is **synced onto the account** (rename in the directory), on a
best-effort basis: `users.email` is unique, so the update can legitimately fail
when another account already holds the new address. Failing the login over that
would lock a user out of an account they demonstrably own, so the conflict is
logged as an error with both addresses and the account id, and the login
continues with the address on file — merge or free the duplicate account to
resolve it.

The login methods are not exclusive: `users.provider` records only how the
account was created and never gates a login, so an account created via OAuth
can still sign in with a magic link (and with a passkey once one is
registered), and vice versa. The only method that needs a prerequisite is the
password login — an account created by OAuth or by a magic link has no
password until one is set via password reset.

### Configuration

| Variable | Meaning |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | enables "Sign in with Google" |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | enables "Sign in with Microsoft" |
| `MICROSOFT_TENANT_ID` | optional Entra directory (tenant GUID or `organizations`); defaults to `common` |

`defineServer` options: `oauthCallbackUrl` (where a successful login lands by
default) and `oauthInvitationCodeUrl` (the page that asks a brand-new user for
an invitation code, default `/oauth-invitation-code.html`).

Redirect URI to register with the provider:
`<baseUrl><basePath>/user/auth/<provider>/callback`

---

## User Self-Service Endpoints (JWT required)

These endpoints allow authenticated users to manage their own account and memberships:

- **GET `/api/v1/user/me`**  
  Get the current user's profile.

- **PUT `/api/v1/user/me`**  
  Update the current user's profile (name, image, phone, etc.).
  **Body:**
  ```json
  {
    "firstname": "John",
    "surname": "Doe",
    "image": "base64string",
    "lastOrganisationId": "orgId",
    "phoneNumber": "+49123456789"
  }
  ```

- **PUT `/api/v1/user/me/password`**  
  Change the current user's password.
  **Body:**
  ```json
  {
    "oldPassword": "currentPassword",
    "newPassword": "newPassword"
  }
  ```

- **POST `/api/v1/user/me/email-change`**  
  Request a change of the own email address. Nothing is written to the account
  yet — see "Changing the email address" below.
  **Body:**
  ```json
  {
    "newEmail": "new@example.com",
    "password": "currentPassword"
  }
  ```
  `password` is required whenever the account has a local password.

- **GET `/api/v1/user/me/email-change`**  
  Get the own pending email change request (`{ "pending": false }` when there
  is none).

- **DELETE `/api/v1/user/me/email-change`**  
  Cancel the own pending email change request.

- **POST `/api/v1/user/profile-image`**  
  Upload or update the user's profile image.
  **Body:**
  Multipart form-data with a `file` field containing the image.

- **GET `/api/v1/user/profile-image`**  
  Get the user's profile image.

- **POST `/api/v1/user/setup`**  
  Setup the user's first organization (if none exists yet).
  **Body:**
  ```json
  {
    "tenantName": "My First Org"
  }
  ```

- **GET `/api/v1/user/tenants`**  
  List all organizations the user is a member of.

- **GET `/api/v1/user/tenants/invitations`**  
  List all pending invitations for the user.

- **DELETE `/api/v1/user/tenant/:tenantId/membership`**  
  Leave an organization.
  **Param:** `tenantId` in URL

- **GET `/api/v1/user/tenant/:tenantId/teams`**  
  List all teams the user is a member of in a given organization.
  **Param:** `tenantId` in URL

- **DELETE `/api/v1/user/tenant/:tenantId/teams/:teamId/membership`**  
  Leave a team.
  **Param:** `tenantId`, `teamId` in URL

- **GET `/api/v1/user/last-tenant`**  
  Get the user's last active organization.

- **PUT `/api/v1/user/last-tenant`**  
  Set the user's last active organization.
  **Body:**
  ```json
  {
    "tenantId": "orgId"
  }
  ```

- **GET `/api/v1/user/search?email=...`**  
  Search for users by email address.
  **Query:** `?email=user@example.com`

- **GET `/api/v1/user/refresh-token`**  
  Refresh the user's JWT token.

- **GET `/api/v1/user/api-tokens/available-scopes`**  
  List all available scopes for API tokens.

- **POST `/api/v1/user/api-tokens`**  
  Create a new API token for the user.
  **Body:**
  ```json
  {
    "name": "My Token",
    "scopes": ["user:read", "user:write"],
    "expiresIn": 1440,
    "tenantId": "orgId"
  }
  ```

- **GET `/api/v1/user/api-tokens`**  
  List all API tokens for the user.

- **DELETE `/api/v1/user/api-tokens/:tokenId`**  
  Revoke (delete) an API token.
  **Param:** `tokenId` in URL

- **POST `/api/v1/user/start-phone-validation`**  
  Start phone number validation (sends a PIN via WhatsApp).

- **GET `/api/v1/user/validate-phone?pin=...`**  
  Validate phone number with a PIN.
  **Query:** `?pin=123456`

---

### Changing the email address

The email address is a user's identity (login, invitations, password reset all
key on it), so it is never written straight from an API call. A change is a
two-step flow, mirroring the magic-link trust model:

1. `POST /api/v1/user/me/email-change` parks the request in
   `base_email_change_requests`. `users.email` stays untouched. A confirmation
   link is mailed to the **new** address, and a heads-up mail (without a link)
   to the **old** one, so a hijacked session cannot silently move the account.
2. The link opens the confirmation page (`/change-email.html`, configurable via
   `verifyEmailChangeUrl`). The page first calls
   `GET /api/v1/user/email-change/info` to show which address is about to be
   confirmed and only applies the change on an explicit click, via
   `POST /api/v1/user/email-change/confirm`. Merely opening the link — which
   corporate mail scanners do automatically — changes nothing.
3. On confirmation `users.email` is updated and `emailVerified` is set: reading
   mail at the new address is the verification.

Guarantees:

- Only the SHA-256 hash of the confirmation token is stored.
- Single-use token, TTL from `emailChangeTtl` (default 1 hour).
- One open request per user; a new request supersedes the previous one.
- The target address is checked for availability when requesting *and* again
  when confirming (two accounts may race for the same address).
- A request is rejected when the account's address changed in the meantime, so
  a stale link cannot revert a newer state.

Email templates: `verifyEmailChange` (to the new address, carries the link) and
`emailChangeNotice` (to the old address). Both can be overridden through
`emailTemplates` in `defineServer`.

---

## Organization, Team, and Invitation Endpoints

(See previous section for details. All routes are prefixed with `/api/v1/`.)

For endpoints that require a body, here are some examples:

- **POST `/api/v1/tenant`**  
  Create a new organization.
  **Body:**
  ```json
  {
    "name": "My Organisation"
  }
  ```

- **PUT `/api/v1/tenant/:tenantId`**  
  Update organization details.
  **Body:**
  ```json
  {
    "name": "New Name"
  }
  ```

- **POST `/api/v1/tenant/:tenantId/invite`**  
  Invite a user by email.
  **Body:**
  ```json
  {
    "email": "invitee@example.com",
    "role": "member",
    "sendMail": true
  }
  ```

- **POST `/api/v1/tenant/:tenantId/members`**  
  Add an existing user as a member.
  **Body:**
  ```json
  {
    "userId": "userId",
    "role": "member"
  }
  ```

- **PUT `/api/v1/tenant/:tenantId/members/:memberId`**  
  Change a member's role.
  **Body:**
  ```json
  {
    "role": "admin"
  }
  ```

- **POST `/api/v1/tenant/:tenantId/teams`**  
  Create a new team.
  **Body:**
  ```json
  {
    "name": "Team Name",
    "description": "Optional description"
  }
  ```

- **PUT `/api/v1/tenant/:tenantId/teams/:teamId`**  
  Update a team.
  **Body:**
  ```json
  {
    "name": "New Team Name",
    "description": "Updated description"
  }
  ```

- **POST `/api/v1/tenant/:tenantId/teams/:teamId/members`**  
  Add a member to a team.
  **Body:**
  ```json
  {
    "userId": "userId",
    "role": "member"
  }
  ```

- **PUT `/api/v1/tenant/:tenantId/teams/:teamId/members/:destinationUserId`**  
  Change a team member's role.
  **Body:**
  ```json
  {
    "role": "admin"
  }
  ```

- **POST `/api/v1/tenant/:tenantId/invitations`**  
  Create an invitation.
  **Body:**
  ```json
  {
    "tenantId": "orgId",
    "email": "invitee@example.com",
    "role": "member"
  }
  ```

- **GET `/api/v1/tenant/:tenantId/search/user?email=...`**  
  Suche nach einem Benutzer anhand der E-Mail-Adresse innerhalb einer Organisation.  
  **Param:** `tenantId` in der URL  
  **Query:** `?email=user@example.com`  
  **Response:**  
  ```json
  {
    "id": "000-0000-0000-0000",
    "email": "user@example.com",
    "firstname": "Max",
    "surname": "Mustermann"
  }
  ```
  
  **Beschreibung:**  
  Mit diesem Endpunkt kann ein Benutzer anhand seiner E-Mail-Adresse innerhalb einer bestimmten Organisation gesucht werden. Es werden die Basisdaten des gefundenen Benutzers zurückgegeben.

---

## Configuration

The user management works out of the box. You may want to configure the following:

- **Scopes and Permissions:**  
  API routes are protected by scopes (e.g., `tenants:read`, `teams:write`). Permissions are managed via user roles (owner, admin, member).

- **Email Sending:**  
  For invitation emails, an email service must be configured if you use the `sendMail` option.

- **Database:**  
  All user, organization, and team data is stored in the connected database. Initialization happens automatically when the framework starts.

- **Email change:**  
  `verifyEmailChangeUrl` (default `/change-email.html`) points at the page that
  confirms a pending address change, `emailChangeTtl` (default 3600 s) sets how
  long a confirmation link stays valid.

- **Customization:**  
  You can extend the default routes or add your own middlewares if you have special requirements.
