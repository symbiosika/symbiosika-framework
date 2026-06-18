/**
 * @framework/db — database connection & schema bootstrap.
 *
 * `getDb()` returns the singleton drizzle client. For the actual table
 * definitions, import from `@framework/schema`.
 *
 * Part of the curated framework public API. See ./README.md.
 */
export {
  getDb,
  waitForDbConnection,
  createDatabaseClient,
} from "../lib/db/db-connection";
export {
  getDbSchema,
  getValidDbSchemaTableNames,
  type DatabaseSchema,
} from "../lib/db/db-schema";
