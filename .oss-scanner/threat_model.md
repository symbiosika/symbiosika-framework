# Threat model — symbiosika-framework

## What this project does and where untrusted input enters

symbiosika-framework is a TypeScript backend framework (Bun, Hono, PostgreSQL
with pgvector, Drizzle ORM). Applications call `defineServer()` and get a
multi-tenant SaaS backend: user management and authentication, tenants
(organisations), teams, permission groups, invitations, file storage, webhooks,
server-to-server connections, background jobs, an OAuth2/OIDC provider, an MCP
endpoint and AI/knowledge features (RAG over tenant documents).

Assume every HTTP request is hostile. Untrusted input enters through:

- **HTTP API** (`src/routes/**`, mounted under the app's `basePath`): JSON
  bodies, query strings, path parameters (`:tenantId`, ids), headers, cookies.
- **Authentication flows** (`src/lib/auth/**`, `src/routes/user/public.ts`):
  password login, email OTP, magic links, passkeys/WebAuthn, external OAuth
  login, phone, API tokens, impersonation, sessions/JWT.
- **OAuth2/OIDC provider** (`src/lib/oauth2/**`): authorize/consent, token,
  dynamic client registration, PKCE, refresh tokens.
- **File uploads and downloads** (`src/lib/storage/**`, `src/lib/files/**`):
  file names, content, storage keys for the `db`, `local` and `s3` backends.
- **Outbound fetches driven by user input**: URL parser / web import
  (`src/lib/url/**`), webhook delivery (`src/lib/webhooks/**`),
  connections to other servers (`src/lib/connections/**`).
- **Documents and text fed to LLMs** (`src/lib/ai/**`, `src/lib/knowledge/**`),
  and the MCP endpoint (`src/lib/mcp/**`).
- **Inbound webhooks** from third parties (e.g. WhatsApp).

Trusted: the operator's environment variables / `.env`, the application code
that calls `defineServer()`, and the PostgreSQL server itself.

## Components that matter most / least

Most important:

1. **Tenant isolation.** A user of tenant A must never read, change or delete
   data of tenant B (files, knowledge, secrets, connections, webhooks,
   invitations, teams, permission groups, jobs, settings). Every route under
   `/tenant/:tenantId/**` must check membership/role for that tenant *and*
   bind every id it touches to that tenant. Cross-tenant IDOR is our top
   concern.
2. **Authentication and session/token handling**: JWT signing and
   verification, cookies, API tokens, OTP/magic-link replay, passkeys,
   impersonation, the OAuth2/OIDC server (code/refresh-token reuse, redirect
   URI validation, PKCE, CSRF on consent).
3. **Authorization inside a tenant**: member vs. admin vs. owner, permission
   groups, `validateScope`, the admin routes under `src/routes/admin`.
4. **SSRF** in the URL parser, webhook delivery and connections
   (`src/lib/utils/url-guard.ts` is the intended guard).
5. **Path traversal / storage key injection** in the local and S3 storage.
6. **Secrets at rest**: tenant secrets encrypted with `SECRETS_AES_KEY`, key
   material of connections, secrets leaking into logs or error responses.
7. SQL injection (Drizzle is parameterised; look for `sql.raw` and string
   interpolation into `sql` templates).

Less important but in scope: the AI/knowledge features (prompt injection is
only relevant if it leads to data access across tenants or users, or to tool
calls the user is not allowed to make), email templates (HTML injection),
CSV import, cron/job scheduling.

Out of scope:

- `demo.ts`, `dev-server/`, `.scripts/` (local developer tooling) and `docs/`.
- `src/api/testing.ts` and `*.test.ts` files.
- Third-party dependencies in `node_modules/` (report them only when the
  framework uses them in an unsafe way).
- Behaviour that requires a malicious operator or access to the environment
  variables.

## How to exercise it

- Build output is in `lib/` (`bun run build`); the source is in `src/`.
- Tests run against an embedded PGlite database (Postgres wire protocol, with
  pgvector), no Docker and no network needed:
  - `bun run test:local` — whole suite
  - `bun run test:local src/routes/tenant/index.test.ts` — one file
  - `bun run test:local --serve` — just start the test DB on 127.0.0.1:5499
    with migrations applied, e.g. for `bun run dev` against it
- Test helpers that create users, tenants and sessions are in `src/test/` and
  `src/api/testing.ts`. Route tests (e.g. `src/routes/**/*.test.ts`,
  `src/routes/tenant/[tenantId]/invitations/security.test.ts`) show how to
  call the Hono app with two users in two tenants. A reproducer as a
  `bun test` file using these helpers is the preferred format.
- Tests that call external AI providers (Mistral, OpenAI-compatible) need API
  keys and network and fail in the offline scanner. Ignore those failures.
- A previous internal review is in `docs/security-review-2026-06.md`. Findings
  marked "Behoben" there are fixed; findings marked "Report only" are known.
  Report a known finding again only if it is still exploitable and you can
  show a working reproducer.

## How you rate severity

- **Critical**: unauthenticated account takeover or token forgery; any
  cross-tenant read or write of tenant data or secrets; remote code
  execution; SQL injection reachable by any user.
- **High**: privilege escalation within a tenant (member → admin/owner);
  authenticated account takeover of another user; SSRF that reaches internal
  networks or cloud metadata; path traversal that reads or writes outside the
  storage root; OAuth2 flaws that leak codes or tokens; leaking secrets
  (AES keys, JWT keys, API tokens, connection keys).
- **Medium**: CSRF on state-changing endpoints, stored XSS in content the
  framework renders (HTML views in OAuth2/consent, emails), missing rate
  limiting on authentication endpoints, user enumeration with a real impact,
  race conditions on single-use tokens.
- **Low**: information disclosure without sensitive data, verbose errors,
  hardening issues.
- Denial of service is Medium at most, Low if it needs an authenticated
  tenant admin.

## Anything to leave alone

- The middleware `checkUserPermission` in `src/lib/utils/hono-middlewares.ts`
  is intentionally disabled (marked HACK); do not report its absence on its
  own. Report missing authorization only if no other check protects the route.
- Insecure defaults in local development tooling (`dev-server/`,
  `.env.default`, fixed test keys in `.scripts/test-local.ts`).
- CORS `ALLOWED_ORIGINS="*"` as a configurable default.

## Reports and patches

Please send a short description, the affected route or function with file and
line, a reproducer (ideally a `bun test` file), and a minimal patch. Patches
should follow the existing code style and come with a test.
