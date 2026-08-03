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

### Social login and existing accounts

Accounts are resolved **by e-mail address**, not by `email + provider`: the
provider has just verified the address, and `users.email` is unique, so one
address is always one account. A user created by a magic link (`provider:
"local"`) can therefore sign in with Microsoft or Google afterwards; the
`provider` column keeps recording how the account was originally created.
Unknown addresses are registered on the spot (with `emailVerified: true`,
pending organisation invitations accepted and the post-register actions run).

### Configuration

| Variable | Meaning |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | enables "Sign in with Google" |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | enables "Sign in with Microsoft" |
| `MICROSOFT_TENANT_ID` | optional Entra directory (tenant GUID or `organizations`); defaults to `common` |

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

- **Customization:**  
  You can extend the default routes or add your own middlewares if you have special requirements.
