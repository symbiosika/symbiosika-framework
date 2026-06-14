/**
 * Local development database.
 *
 * Starts an embedded, file-backed PGlite database and exposes it over the
 * PostgreSQL wire protocol via a TCP socket. The framework's app then connects
 * to it with the normal postgres-js driver using the existing POSTGRES_* env
 * vars (host=localhost) — no changes to the app's DB layer required, and
 * `drizzle-kit migrate/push/studio` work against it natively.
 *
 * Usage:
 *   Terminal 1:  bun run db:local
 *   Terminal 2:  bun run framework:migrate   (once / after new migrations)
 *                bun run dev
 *
 * PGlite is a single-connection database; pglite-socket multiplexes (serializes)
 * multiple connections, so maxConnections must be >= the postgres-js pool size
 * (default 10).
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { mkdirSync } from "node:fs";

const DIR = process.env.LOCAL_DB_DIR ?? "./dev-db/pglite";
const PORT = parseInt(process.env.POSTGRES_PORT ?? "5432");
const HOST = process.env.LOCAL_DB_HOST ?? "127.0.0.1";
const MAX = parseInt(process.env.LOCAL_DB_MAX_CONNECTIONS ?? "20");

// PGlite's NodeFS only creates the final path segment, not parent directories,
// so ensure the full (possibly nested) data dir exists first.
mkdirSync(DIR, { recursive: true });

// PGlite with a persistent data dir and the pgvector extension loaded.
const db = await PGlite.create(DIR, { extensions: { vector } });

// Enable pgvector (idempotent — persists across restarts).
await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");

const server = new PGLiteSocketServer({
  db,
  port: PORT,
  host: HOST,
  maxConnections: MAX,
});
await server.start();
console.log(
  `PGlite socket server listening on ${HOST}:${PORT} (dir: ${DIR}, maxConnections: ${MAX})`
);

const shutdown = async () => {
  console.log("Shutting down PGlite socket server...");
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
