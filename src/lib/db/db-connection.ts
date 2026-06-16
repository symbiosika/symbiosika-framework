import { getDbSchema, type DatabaseSchema } from "./db-schema";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

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

const POSTGRES_DB = process.env.POSTGRES_DB ?? "";
const POSTGRES_USER = process.env.POSTGRES_USER ?? "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "";
const POSTGRES_HOST = process.env.POSTGRES_HOST ?? "";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT ?? "5432");
const POSTGRES_CA = process.env.POSTGRES_CA?.trim() || undefined;
const useSSL = !!POSTGRES_CA;
const POSTGRES_CHECK_IDENTITY =
  process.env.POSTGRES_CHECK_IDENTITY?.trim().toLowerCase() === "true";
const POSTGRES_CONNECTION_POOL_SIZE = process.env.POSTGRES_CONNECTION_POOL_SIZE
  ? parseInt(process.env.POSTGRES_CONNECTION_POOL_SIZE)
  : undefined;

console.log(
  "POSTGRES SSL is",
  useSSL
    ? `enabled (CA provided, identity check: ${POSTGRES_CHECK_IDENTITY})`
    : "disabled"
);

if (POSTGRES_CONNECTION_POOL_SIZE) {
  console.log(
    "CONNECTION_POOL_SIZE is ",
    POSTGRES_CONNECTION_POOL_SIZE
  )
}

// PostgresJS client
let dbClient = postgres(
  `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`,
  {
    ...(POSTGRES_CONNECTION_POOL_SIZE !== undefined && {
      max: POSTGRES_CONNECTION_POOL_SIZE,
    }),
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
let drizzleClient: PostgresJsDatabase<DatabaseSchema>;

export const createDatabaseClient = (
  customSchema?: Record<string, unknown>
) => {
  if (drizzleClient) {
    console.log("DB Client already initialized");
    return drizzleClient;
  }
  const schema = { ...getDbSchema(), ...customSchema };
  drizzleClient = drizzle(dbClient, { schema, logger: false });
  return drizzleClient;
};

export const getDb = () => {
  if (!drizzleClient) {
    createDatabaseClient();
  }
  if (!drizzleClient) {
    throw new Error("Database client not initialized");
  }
  return drizzleClient;
};

export const waitForDbConnection = async () => {
  console.log("check db connection");
  while (!drizzleClient) {
    console.log("Waiting for database connection...");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log("db connection established");
};
