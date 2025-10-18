# Built-in User Management

## Overview

The Fastapp Framework comes with a fully integrated user management system. As soon as you start a webserver with the framework, all essential features for managing users, organizations, teams, and invitations are available out of the box—including the necessary API routes. You do not need to implement your own user management: authentication, authorization, and all core endpoints are ready to use.

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
  List available OAuth providers (e.g., Google, Microsoft).

- **GET `/api/v1/user/auth/:provider`**  
  Redirect to OAuth login for the given provider.
  **Query (optional):** `?redirectUrl=...`

- **GET `/api/v1/user/auth/:provider/callback`**  
  Handle OAuth callback and complete authentication.
  **Query:** `?code=...&state=...`

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
    "organisationName": "My First Org"
  }
  ```

- **GET `/api/v1/user/organisations`**  
  List all organizations the user is a member of.

- **GET `/api/v1/user/organisations/invitations`**  
  List all pending invitations for the user.

- **DELETE `/api/v1/user/organisation/:organisationId/membership`**  
  Leave an organization.
  **Param:** `organisationId` in URL

- **GET `/api/v1/user/organisation/:organisationId/teams`**  
  List all teams the user is a member of in a given organization.
  **Param:** `organisationId` in URL

- **DELETE `/api/v1/user/organisation/:organisationId/teams/:teamId/membership`**  
  Leave a team.
  **Param:** `organisationId`, `teamId` in URL

- **GET `/api/v1/user/last-organisation`**  
  Get the user's last active organization.

- **PUT `/api/v1/user/last-organisation`**  
  Set the user's last active organization.
  **Body:**
  ```json
  {
    "organisationId": "orgId"
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
    "organisationId": "orgId"
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

- **POST `/api/v1/organisation`**  
  Create a new organization.
  **Body:**
  ```json
  {
    "name": "My Organisation"
  }
  ```

- **PUT `/api/v1/organisation/:organisationId`**  
  Update organization details.
  **Body:**
  ```json
  {
    "name": "New Name"
  }
  ```

- **POST `/api/v1/organisation/:organisationId/invite`**  
  Invite a user by email.
  **Body:**
  ```json
  {
    "email": "invitee@example.com",
    "role": "member",
    "sendMail": true
  }
  ```

- **POST `/api/v1/organisation/:organisationId/members`**  
  Add an existing user as a member.
  **Body:**
  ```json
  {
    "userId": "userId",
    "role": "member"
  }
  ```

- **PUT `/api/v1/organisation/:organisationId/members/:memberId`**  
  Change a member's role.
  **Body:**
  ```json
  {
    "role": "admin"
  }
  ```

- **POST `/api/v1/organisation/:organisationId/teams`**  
  Create a new team.
  **Body:**
  ```json
  {
    "name": "Team Name",
    "description": "Optional description"
  }
  ```

- **PUT `/api/v1/organisation/:organisationId/teams/:teamId`**  
  Update a team.
  **Body:**
  ```json
  {
    "name": "New Team Name",
    "description": "Updated description"
  }
  ```

- **POST `/api/v1/organisation/:organisationId/teams/:teamId/members`**  
  Add a member to a team.
  **Body:**
  ```json
  {
    "userId": "userId",
    "role": "member"
  }
  ```

- **PUT `/api/v1/organisation/:organisationId/teams/:teamId/members/:destinationUserId`**  
  Change a team member's role.
  **Body:**
  ```json
  {
    "role": "admin"
  }
  ```

- **POST `/api/v1/organisation/:organisationId/invitations`**  
  Create an invitation.
  **Body:**
  ```json
  {
    "organisationId": "orgId",
    "email": "invitee@example.com",
    "role": "member"
  }
  ```

- **GET `/api/v1/organisation/:organisationId/search/user?email=...`**  
  Suche nach einem Benutzer anhand der E-Mail-Adresse innerhalb einer Organisation.  
  **Param:** `organisationId` in der URL  
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
  API routes are protected by scopes (e.g., `organisations:read`, `teams:write`). Permissions are managed via user roles (owner, admin, member).

- **Email Sending:**  
  For invitation emails, an email service must be configured if you use the `sendMail` option.

- **Database:**  
  All user, organization, and team data is stored in the connected database. Initialization happens automatically when the framework starts.

- **Customization:**  
  You can extend the default routes or add your own middlewares if you have special requirements.
