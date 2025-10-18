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
let POSTGRE_CA_CERT = process.env.POSTGRE_CA_CERT ?? undefined;
console.log("POSTGRE_CA_CERT is ", POSTGRE_CA_CERT);
if (POSTGRE_CA_CERT === "") {
  POSTGRE_CA_CERT = undefined;
}
const POSTGRES_USE_SSL = !process.env.POSTGRES_USE_SSL
  ? false
  : process.env.POSTGRES_USE_SSL === "true";
const POSTGRES_SSL_REJECT_UNAUTHORIZED = process.env
  .POSTGRES_SSL_REJECT_UNAUTHORIZED
  ? process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== "false"
  : true;

console.log("POSTGRES_USE_SSL is", POSTGRES_USE_SSL);
console.log("POSTGRES_CA", POSTGRE_CA_CERT);

// PostgresJS client
let dbClient = postgres(
  `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`,
  {
    ...(POSTGRES_USE_SSL && {
      ssl: {
        rejectUnauthorized: POSTGRES_SSL_REJECT_UNAUTHORIZED,
        ca: POSTGRE_CA_CERT,
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
