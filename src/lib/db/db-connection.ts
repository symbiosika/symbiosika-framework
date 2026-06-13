import { getDbSchema, type DatabaseSchema } from "./db-schema";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";

/*
// Use BunSQL native client. Try this later.
// import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
// import { SQL } from "bun";
// Buns native clien
// let dbClient = new SQL(
//   `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`
// );
// let drizzleClient: BunSQLDatabase<DatabaseSchema>;
*/

/**
 * When USE_LOCAL_DB=true the framework spins up an embedded, file-backed PGlite
 * database instead of connecting to an external Postgres server. This is meant
 * for local development only (no external Postgres required).
 *
 * The driver is selected at runtime: the default path keeps using postgres-js,
 * the local path lazily loads @electric-sql/pglite + drizzle-orm/pglite via
 * dynamic import so production installs never touch the WASM payload.
 */
const USE_LOCAL_DB = process.env.USE_LOCAL_DB === "true";
const LOCAL_DB_DIR =
  process.env.LOCAL_DB_DIR ?? path.resolve(process.cwd(), "dev-db/pglite");

// The framework's migrations ship alongside the source in /drizzle-sql (repo
// root, sibling of /src). This file lives at src/lib/db (or lib/lib/db once
// compiled), so three levels up reaches the package root in both layouts.
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../../drizzle-sql");

// Declared as PostgresJsDatabase (the default driver's type) so every existing
// getDb() consumer keeps compiling unchanged. The PGlite client exposes the
// identical drizzle query-builder API and is cast into this type in local mode;
// only the underlying result wrapper differs, and both return plain arrays at
// runtime, so consumers are unaffected.
let drizzleClient: PostgresJsDatabase<DatabaseSchema>;

/**
 * The embedded PGlite instance is cached on globalThis so it survives Bun's
 * `--hot` module re-evaluation. PGlite runs in-process and holds a single-writer
 * lock on the data dir; without this cache every hot reload would either lose
 * all data (in-memory) or collide with the still-open lock (file-backed).
 */
type PgliteGlobal = {
  instance?: unknown;
  migrated?: boolean;
  initPromise?: Promise<void>;
  // The built drizzle client is cached too: on a `--hot` reload the module-level
  // `drizzleClient` binding is reset, so we restore it from here instead of
  // re-initializing (which would relock the data dir).
  db?: PostgresJsDatabase<DatabaseSchema>;
};
const globalForPglite = globalThis as unknown as {
  __SF_PGLITE__?: PgliteGlobal;
};
globalForPglite.__SF_PGLITE__ ??= {};

// In local mode the source of truth for the client is globalThis (survives hot
// reloads); the module-level binding is just a per-evaluation cache.
const getActiveClient = (): PostgresJsDatabase<DatabaseSchema> | undefined =>
  drizzleClient ?? (USE_LOCAL_DB ? globalForPglite.__SF_PGLITE__!.db : undefined);

const initLocalDb = async (customSchema?: Record<string, unknown>) => {
  const cache = globalForPglite.__SF_PGLITE__!;

  if (!cache.instance) {
    const { PGlite } = await import("@electric-sql/pglite");
    // The schema uses vector(1536)/vector(1024) columns and migration 0000 runs
    // `CREATE EXTENSION vector`, so the pgvector extension must be loaded here.
    const { vector } = await import("@electric-sql/pglite-pgvector");
    // PGlite's NodeFS only creates the final path segment, not parent
    // directories, so ensure the full (possibly nested) data dir exists first.
    const fs = await import("node:fs");
    fs.mkdirSync(LOCAL_DB_DIR, { recursive: true });
    console.log("Starting embedded PGlite database at", LOCAL_DB_DIR);
    cache.instance = new PGlite(LOCAL_DB_DIR, {
      extensions: { vector },
    });
    await (cache.instance as { waitReady: Promise<void> }).waitReady;
  }

  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const schema = { ...getDbSchema(), ...customSchema };
  const client = drizzlePglite(cache.instance as never, {
    schema,
    logger: false,
  });

  // Run the framework migrations programmatically (drizzle-kit migrate cannot
  // talk to an embedded instance). The migrator checks the base_migrations
  // table, so this is a no-op once up to date; the flag avoids the round-trips
  // on every hot reload.
  if (!cache.migrated) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    console.log("Running migrations on embedded PGlite database...");
    await migrate(client as never, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsTable: "base_migrations",
    });
    cache.migrated = true;
  }

  drizzleClient = client as unknown as PostgresJsDatabase<DatabaseSchema>;
  globalForPglite.__SF_PGLITE__!.db = drizzleClient;
  console.log("Embedded PGlite database ready");
};

const initExternalDb = (customSchema?: Record<string, unknown>) => {
  const POSTGRES_DB = process.env.POSTGRES_DB ?? "";
  const POSTGRES_USER = process.env.POSTGRES_USER ?? "";
  const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "";
  const POSTGRES_HOST = process.env.POSTGRES_HOST ?? "";
  const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT ?? "5432");
  const POSTGRES_CA = process.env.POSTGRES_CA?.trim() || undefined;
  const useSSL = !!POSTGRES_CA;
  const POSTGRES_CHECK_IDENTITY =
    process.env.POSTGRES_CHECK_IDENTITY?.trim().toLowerCase() === "true";

  console.log(
    "POSTGRES SSL is",
    useSSL
      ? `enabled (CA provided, identity check: ${POSTGRES_CHECK_IDENTITY})`
      : "disabled"
  );

  const dbClient = postgres(
    `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`,
    {
      ...(useSSL && {
        ssl: {
          rejectUnauthorized: false,
          ca: POSTGRES_CA,
          ...(!POSTGRES_CHECK_IDENTITY && {
            checkServerIdentity: () => undefined,
          }),
        },
      }),
    }
  );

  const schema = { ...getDbSchema(), ...customSchema };
  drizzleClient = drizzle(dbClient, { schema, logger: false });
};

export const createDatabaseClient = (
  customSchema?: Record<string, unknown>
) => {
  if (drizzleClient) {
    console.log("DB Client already initialized");
    return drizzleClient;
  }

  if (USE_LOCAL_DB) {
    const cache = globalForPglite.__SF_PGLITE__!;
    // Restore the cached client after a hot reload (instance + migrations are
    // already done) instead of re-initializing.
    if (cache.db) {
      drizzleClient = cache.db;
      return drizzleClient;
    }
    // First init is async. createDatabaseClient stays sync (index.ts calls it
    // without awaiting); waitForDbConnection() is the gate everything waits on.
    cache.initPromise ??= initLocalDb(customSchema).catch((err) => {
      console.error("Failed to initialize local PGlite database:", err);
      cache.initPromise = undefined; // allow retry
      throw err;
    });
    return drizzleClient;
  }

  initExternalDb(customSchema);
  return drizzleClient;
};

export const getDb = () => {
  let client = getActiveClient();
  if (!client) {
    createDatabaseClient();
    client = getActiveClient();
  }
  if (!client) {
    throw new Error("Database client not initialized");
  }
  drizzleClient = client;
  return drizzleClient;
};

export const waitForDbConnection = async () => {
  console.log("check db connection");
  while (!getActiveClient()) {
    console.log("Waiting for database connection...");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Sync the module-level binding for this (possibly reloaded) module instance.
  drizzleClient = getActiveClient()!;
  console.log("db connection established");
};
