---
name: backend-testing
description: >
  Use when the user asks to write, create, fix, or run a backend test.
  Use when editing *.test.ts files in a backend.
  Use when the user asks about test setup, initTests(), testFetcher, test
  assertions, end-to-end tests, or when a test fails and needs diagnosing.
  A database is always available (`bun run test:local`) — never skip or stub a
  test because "there is no DB"; see the `local-database` skill.
---

# Backend Testing

Uses Bun's built-in test framework (`bun:test`) against a **real database and a
real Hono app** — nothing is mocked.

## Running Tests (zero setup — use this)

`bun run test:local` runs tests against an **embedded PGlite database** — no
Docker, no external Postgres, no `.env` needed. It starts PGlite (with
pgvector) on port 5499, applies framework + app migrations, sets all required
env defaults (DB, JWT secret, `SMTP_HOST=console.localhost`), runs the tests,
and shuts down. Always run it from the `backend/` directory. Never use `cd`.

```bash
bun run test:local                                    # all tests
bun run test:local ./src/lib/example.test.ts          # one file
bun run test:local --fresh                            # wipe the test DB first
bun run test:local --keep ./src/lib/example.test.ts   # keep DB serving after tests
bun run test:local --serve                            # only start test DB + migrations
```

Notes:
- The test DB persists in `dev-db/pglite-test-<port>/` (gitignored); repeat runs are fast.
  Use `--fresh` after schema experiments or when state looks corrupted.
- With `--keep`/`--serve` you can inspect data afterwards:
  `POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5499 POSTGRES_DB=postgres POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres bun run db:query "SELECT ..."`
- App-specific test env (e.g. feature stubs) belongs in the app's `test:local`
  script line in `package.json`, not in the runner.
- Bare `bun test <file>` also works, but only if a database is already running
  and `POSTGRES_*`/JWT env is set — prefer `test:local`.
- Suites whose describe-name says `needs MISTRAL_API_KEY` (or similar) call real
  AI APIs; without those keys they fail slowly with retries/timeouts. That is
  expected — skip them when running offline instead of chasing the failures.
- JWT gotcha: session tokens are **HS256** — `JWT_PRIVATE_KEY` and
  `JWT_PUBLIC_KEY` must contain the **same** secret, otherwise every
  authenticated request returns 401. `test:local` handles this for you.
- Ports, persistent dev DB, reset and DB troubleshooting: **`local-database` skill**.
  "No database available" is never a valid reason to skip or stub a test.

## Test end-to-end, not just the unit

Unit-testing the helper you happened to touch is **not** sufficient. Every change
to an endpoint or to business logic needs a test that drives the **full path** —
HTTP request → route → middleware/auth → business logic → real DB → response
body — with `testFetcher` against the real app.

For a new or changed endpoint, cover all of these:

1. **Happy path through the full stack** — assert the response body *and* prove
   the data really landed (follow-up read, or a direct DB query).
2. **The whole lifecycle**, not a single verb — create → read → update → delete,
   each step using the IDs the previous one returned.
3. **Auth** — the same request without a token is `401`.
4. **Tenant isolation** — a user from another tenant gets `403`/`404`, never data.
5. **Validation** — at least one malformed payload returns `400`.
6. **Cross-boundary flows** — when a change spans services or transports
   (second backend, MQTT, sync, external API), test across the boundary instead
   of each side in isolation. Name such files `*.e2e.test.ts` /
   `*.integration.test.ts`.

**Run what you claim.** Execute the suite and report its real output. Never
describe a test as passing without having run it, and never report work as done
on a red suite — surface the failure with its message instead. If a specific test
genuinely cannot run in the current environment (e.g. it needs a real broker or
an API key), say exactly which one and why; a missing database is never such a
reason (see the `local-database` skill).

## Test File Structure

Tests are co-located with route files (`*.test.ts`). Security and edge-case tests can be in separate files.

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "@framework/test/init.test";
import { testFetcher } from "@framework/test/fetcher.test";
import { getDb } from "@framework/lib/db/db-connection";
import { Hono } from "hono";
import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import { defineXRoutes } from "./index";
import { xTable } from "../../../../db/schema";
import { eq, and } from "drizzle-orm";

let app: SymbiosikaFrameworkHonoApp;
let adminToken: string;

describe("X Routes", () => {
  beforeAll(async () => {
    const { user1Token } = await initTests();
    adminToken = user1Token;

    app = new Hono();
    defineXRoutes(app);

    // Clean up existing test data
    await getDb()
      .delete(xTable)
      .where(eq(xTable.tenantId, TEST_ORGANISATION_1.id));
  });

  afterAll(() => {
    // Fire and forget cleanup (Bun runtime limitation).
    // End the chain with `.catch`, never a bare `.then`: the promise outlives
    // the test file, and a rejection with no handler is an unhandled rejection
    // between test files. Bun counts that as an error and exits 1 — blamed on
    // whichever file happened to be running when it landed.
    getDb()
      .delete(xTable)
      .where(eq(xTable.tenantId, TEST_ORGANISATION_1.id))
      .catch((error) => console.warn("afterAll cleanup failed:", error));
  });

  test("Full CRUD cycle", async () => {
    // CREATE
    const createResponse = await testFetcher.post(
      app,
      `/tenant/${TEST_ORGANISATION_1.id}/x`,
      adminToken,
      { name: "Test Entry" }
    );
    expect(createResponse.status).toBe(200);
    expect(createResponse.jsonResponse?.success).toBe(true);
    const entryId = createResponse.jsonResponse?.data.id;

    // READ
    const getResponse = await testFetcher.get(
      app,
      `/tenant/${TEST_ORGANISATION_1.id}/x/${entryId}`,
      adminToken
    );
    expect(getResponse.status).toBe(200);
    expect(getResponse.jsonResponse?.data.name).toBe("Test Entry");

    // UPDATE
    const updateResponse = await testFetcher.put(
      app,
      `/tenant/${TEST_ORGANISATION_1.id}/x/${entryId}`,
      adminToken,
      { name: "Updated Entry" }
    );
    expect(updateResponse.status).toBe(200);

    // DELETE
    const deleteResponse = await testFetcher.delete(
      app,
      `/tenant/${TEST_ORGANISATION_1.id}/x/${entryId}`,
      adminToken
    );
    expect(deleteResponse.status).toBe(200);
  });

  test("Unauthorized access", async () => {
    const response = await testFetcher.get(
      app,
      `/tenant/${TEST_ORGANISATION_1.id}/x`,
      undefined // No token
    );
    expect(response.status).toBe(401);
  });
});
```

## Test Infrastructure

### initTests()

Returns tokens and sets up test data:
```typescript
const { user1Token, user2Token, user3Token, adminToken, password } = await initTests();
```

### testFetcher

Methods: `get`, `post`, `put`, `patch`, `delete`, `postFormData`, `postWithPlainResponse`

Signature: `testFetcher.method(app, path, token, body?)`

Returns: `{ status, jsonResponse, textResponse, headers }`

Token passed as `Authorization: Bearer ${token}`. Use `undefined` for unauthenticated requests.

### Test Data Constants

```typescript
import {
  TEST_ORGANISATION_1,  // Org owned by user1
  TEST_ORGANISATION_2,
  TEST_ORGANISATION_3,
  TEST_ORG1_USER_1,     // Owner of org1
  TEST_ORG1_USER_2,     // Member of org1
  TEST_ORG1_USER_3,     // Member of org1
  TEST_ORG2_USER_1,
  TEST_ADMIN_USER,      // Owner of all orgs
  TEST_PASSWORD,        // "gFskj6Dn6gFskj6Dn6"
} from "@framework/test/init.test";
```

### Test Helpers

```typescript
import {
  testing_createTeamAndAddUsers,
  testing_deleteTeam,
  testing_createKnowledgeGroup,
  testing_deleteKnowledgeGroup,
} from "@framework/test/permissions.test";
```

## Rules

- **Never mock functions** - use real implementations with test data
- **Use real database connections** - never mock the DB. If the DB is unreachable,
  start it (`bun run test:local`, see the `local-database` skill) instead of
  mocking, stubbing or skipping
- **Never weaken a test to get green** - no `test.skip`, no deleted assertions, no
  loosened expectations to hide a failure. A failing test is a finding to report
- **All tests in single `describe` block** - Bun bug workaround
- **Async cleanup**: fire and forget in `afterAll` (Bun limitation) — but end the
  chain with `.catch(…)`, never a bare `.then(() => {})`. An unhandled rejection
  from a cleanup that outlives its file fails the entire run.
- **Clean up test data** in `beforeAll` AND `afterAll`
- **Path alias**: `@framework/*` → `./framework/src/*`

## Response Conventions

API responses follow `{ success: boolean, data: ... }`:

```typescript
expect(response.jsonResponse?.success).toBe(true);
expect(response.jsonResponse?.data.id).toBe(entryId);
```

Status codes follow the usual semantics (200 / 400 validation / 401 no token /
403 wrong tenant or missing permission / 404).

## Security Test Pattern

```typescript
test("Cross-tenant access rejected", async () => {
  const response = await testFetcher.get(
    app,
    `/tenant/${TEST_ORGANISATION_1.id}/x`,
    user2Token // User from different tenant
  );
  expect(response.status).toBe(403);
});
```

## Workaound for hanging postgre tasks

Bun has problems with hanging postgre tasks!

https://github.com/oven-sh/bun/issues/19130

This will fail hang forever:
```ts
import { test, expect } from 'bun:test';
import { SQL } from 'bun';

const sql = new SQL('postgres://user@localhost:5432/db', { prepare: false });

test('hangs forever', async () => {
  await expect(
    sql.unsafe(`SELECT * FROM table_that_does_not_exist`)
  ).rejects.toThrow();
});

```

This is a workaround(!):
```ts
let threw = false;
try {
  await sql.unsafe(`SELECT * FROM table_that_does_not_exist`);
} catch {
  threw = true;
}
expect(threw).toBe(true);
```
