---
name: local-database
description: >
  Start and use a local database. There is ALWAYS a database available — an
  embedded PGlite Postgres (`bun run test:local` for tests, `bun run db:local`
  for a dev DB), no Docker and no cloud database needed. Use BEFORE saying
  anything like "I have no database", "no DB available", "cannot run tests
  without a database", "keine DB", "ich kann nicht testen". Use when running
  tests, applying migrations, seeding, starting the dev server, inspecting data,
  or when something fails with ECONNREFUSED / "connect to database" /
  "relation does not exist" / a Postgres port that is not listening.
---

# Local database (PGlite) — there is always a DB

The framework ships an **embedded, file-backed Postgres** (PGlite + pgvector)
served over the normal Postgres wire protocol. Docker is not required, no
external Postgres is required, and for tests not even an `.env` is required.
There is therefore **no situation in which testing must be skipped for lack of a
database** — if you were about to say so, start the DB instead.

Run every command from the backend root (the directory containing `package.json`
and, in an app, `framework/`). Never `cd` inside a command.

## 1. Tests → `bun run test:local` (zero setup, use this by default)

Starts PGlite on its own port (default 5499), applies framework + app
migrations, injects every env var the framework needs (DB, matching HS256
`JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`, `SECRETS_AES_KEY`/`IV`,
`SMTP_HOST=console.localhost`), runs the tests and shuts down.

```bash
bun run test:local                                    # all tests
bun run test:local ./src/lib/example.test.ts          # one file
bun run test:local --fresh                            # wipe the test DB first
bun run test:local --keep ./src/lib/example.test.ts   # keep the DB serving afterwards
bun run test:local --serve                            # only start test DB + migrations
```

The test DB persists in `dev-db/pglite-test-<port>/` (gitignored), so repeat runs
skip the migration work. `TEST_DB_PORT` / `TEST_DB_DIR` override port and dir —
useful when a second instance must run concurrently.

If `bun run test:local` reports an unknown script, the app has not wired the
runner up yet — add it to the backend's `package.json` and use it from then on:

```json
"test:local": "bun run ./framework/.scripts/test-local.ts"
```

Until then, fall back to the persistent dev DB below (`db:local` + `migrate`, then
`bun test <file>`) — not to skipping the tests.

Details and test patterns: **`backend-testing` skill**.

## 2. Dev database → `bun run db:local`

For the dev server, seeds or `drizzle-kit` work against a persistent DB on the
normal port from `.env` (`POSTGRES_*`, usually 5432):

```bash
bun run init                            # once: writes .env (idempotent)
bun run db:local > pglite.log 2>&1 &    # background; keep it running
bun run migrate                         # or framework:migrate in the framework repo
```

It prints `PGlite socket server listening on 127.0.0.1:<port> (dir: ./dev-db/pglite, ...)`
when ready. Start it **once** per session and leave it alive — do not run it in
the foreground (it never exits). `LOCAL_DB_DIR`, `LOCAL_DB_HOST` and
`POSTGRES_PORT` override its location.

PGlite is a single-connection engine and `pglite-socket` serializes connections,
so keep `POSTGRES_CONNECTION_POOL_SIZE=1` for the dev DB (what `bun run init`
writes). Apps that host several backends give each one its own port and
`POSTGRES_DB` in its own `.env`, so multiple instances can run side by side.

## 3. Inspect the data → `bun run db:query`

```bash
bun run db:query "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
```

Against a `--keep`/`--serve` test DB, point the env at it:

```bash
POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5499 POSTGRES_DB=postgres \
POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres \
  bun run db:query "SELECT count(*) FROM base_users"
```

Framework tables carry the `base_` prefix. More: **`db-query` skill**.

## Reset a broken DB

```bash
bun run test:local --fresh              # test DB
# dev DB:
pkill -f local-db-server
rm -rf dev-db                           # drops the PGlite data dir
bun run db:local > pglite.log 2>&1 &
bun run migrate
```

## Troubleshooting

| Symptom                                                | Cause / fix                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `ECONNREFUSED` on the Postgres port                    | no DB running → `bun run test:local` (tests) or `bun run db:local` (dev)  |
| `relation "..." does not exist`                        | migrations not applied → `bun run migrate` (`test:local` does it for you) |
| `could not listen on port` from `test:local`           | another instance still running → stop it or set `TEST_DB_PORT`            |
| every authenticated request returns `401`              | `JWT_PRIVATE_KEY` ≠ `JWT_PUBLIC_KEY` (HS256, must match) → `test:local`   |
| process exits mid-test-run without a failure           | missing `SECRETS_AES_KEY`/`IV` → `test:local` provides them               |
| `.env` missing / `POSTGRES_*` undefined for the dev DB | `bun run init`                                                           |
| migration fails on a half-applied schema               | reset the data dir (above), then migrate again                            |
| a query hangs forever instead of throwing              | Bun/postgres bug — workaround in the `backend-testing` skill              |

## What this unlocks

With a DB available, all of these are expected of you instead of guessing:
end-to-end route tests through the real Hono app (`testFetcher`), `initTests()`
fixtures, migrations, seeds, reading the real rows with `db:query`, and the dev
server for manual checks. Use them.
