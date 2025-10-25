import { defineConfig } from "drizzle-kit";
import path, { resolve } from "path";

// Get absolute path for current directory
const BASE_PATH = resolve(__dirname);
const CWD = process.cwd();
const RELATIVE_PATH = path.relative(CWD, BASE_PATH);
console.log("RELATIVE_PATH is", RELATIVE_PATH);

// Get environment variables for database connection
const POSTGRES_DB = process.env.POSTGRES_DB ?? "";
const POSTGRES_USER = process.env.POSTGRES_USER ?? "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "";
const POSTGRES_HOST = process.env.POSTGRES_HOST ?? "";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT ?? "5432");
const POSTGRES_CA = process.env.POSTGRES_CA ?? "";

let POSTGRES_USE_SSL = false;
if (POSTGRES_CA && POSTGRES_CA.length > 0 && POSTGRES_CA !== "none") {
  POSTGRES_USE_SSL = true;
}

console.log("RUNNING MIGRATIONS FOR FRAMEWORK");
console.log("POSTGRES_USE_SSL is", POSTGRES_USE_SSL);

console.log(
  "Connect to database: ",
  `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD.slice(0, 3)}...@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`
);

const PREFIX = "base_";

export default defineConfig({
  dialect: "postgresql",
  schema: RELATIVE_PATH + "/src/lib/db/db-schema.ts",
  out: RELATIVE_PATH + "/drizzle-sql",
  tablesFilter: PREFIX + "*",
  migrations: {
    table: `${PREFIX}migrations`,
  },
  dbCredentials: {
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    database: POSTGRES_DB,
    ...(POSTGRES_USE_SSL && {
      ssl: {
        rejectUnauthorized: false,
        ca: POSTGRES_CA && POSTGRES_CA.length > 0 ? POSTGRES_CA : undefined,
      },
    }),
    ...(POSTGRES_USE_SSL === false && {
      ssl: false,
    }),
  },
});
