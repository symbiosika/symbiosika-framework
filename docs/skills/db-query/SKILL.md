---
name: db-query
description: >
  Use when you need to inspect raw data in the development database by running an arbitrary
  SQL query and reading the result. Use when the user asks to "check the DB", "look up rows",
  "run a query", "see what's in table X", or verify data while debugging. Runs a raw SQL query
  via the framework's getDb() connection against the dev database and prints rows (or the error)
  as JSON to the console.
---

# DB Query Skill

This skill runs a **raw SQL query** against the development database and prints
the result to the console as JSON. It exists so an AI agent (or developer) can
inspect raw data directly without writing a one-off script for every question.

## How it works

- Uses the framework's normal `getDb()` connection (`src/lib/db/db-connection.ts`).
- Connects automatically to the database defined by the local `POSTGRES_*`
  environment variables — i.e. the development environment. No extra config.
- The query is passed **directly on the command line**.
- Output is JSON on the console: rows on success, an error message on failure.

## Usage

```bash
bun run db:query "SELECT * FROM base_tenants LIMIT 5"
```

Equivalent (calling the script directly):

```bash
bun run ./.scripts/db-query.ts "SELECT count(*) FROM base_users"
```

Always wrap the query in quotes so the shell passes it as one argument.

## Output

On success:

```json
{
  "ok": true,
  "rowCount": 2,
  "rows": [
    { "id": "...", "name": "..." }
  ]
}
```

On error (invalid SQL, no DB connection, etc.):

```json
{
  "ok": false,
  "error": "relation \"foo\" does not exist"
}
```

## Notes

- Table names use the framework's prefixes (e.g. `base_tenants`, `base_users`).
  Use a query like `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  to discover available tables.
- This executes raw SQL with no validation — it is a development/inspection tool.
  Prefer `SELECT` for inspection; any statement the connected user is allowed to
  run will execute.
- Requires the dev database to be reachable. For local development start it with
  `bun run db:local` (PGlite on localhost:5432) before querying.
