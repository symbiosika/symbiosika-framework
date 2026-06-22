/**
 * DB Query Script
 *
 * Runs a raw SQL query against the development database and prints the
 * result (or the error) to the console as JSON. The query is passed
 * directly on the command line.
 *
 * The script connects automatically to the database defined by the local
 * POSTGRES_* environment variables (the development environment), using the
 * framework's normal `getDb()` connection — so no extra configuration is
 * required.
 *
 * Purpose:
 *   Lets an AI agent (or a developer) inspect raw data in the dev database
 *   without writing a one-off script for every question.
 *
 * Usage:
 *   bun run db:query "SELECT * FROM base_tenants LIMIT 5"
 *   bun run ./.scripts/db-query.ts "SELECT count(*) FROM base_users"
 *
 * Output (on success):
 *   { "ok": true, "rowCount": <n>, "rows": [ ... ] }
 *
 * Output (on error):
 *   { "ok": false, "error": "<message>" }
 */

import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db/db-connection";

async function main() {
  // Everything after the script path is treated as the query. This allows
  // passing the query either as a single quoted argument or unquoted with
  // multiple tokens.
  const query = process.argv.slice(2).join(" ").trim();

  if (!query) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error:
            'No query provided. Usage: bun run db:query "SELECT * FROM base_tenants LIMIT 5"',
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const db = getDb();
  const result = await db.execute(sql.raw(query));

  // postgres-js returns a RowList (array-like) for query results. Normalize
  // it to a plain array so JSON.stringify produces clean output.
  const rows = Array.isArray(result) ? result : Array.from(result as any);

  console.log(
    JSON.stringify(
      {
        ok: true,
        rowCount: rows.length,
        rows,
      },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )
    );
    process.exit(1);
  });
