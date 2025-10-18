import { getDb } from "./db-connection";
import {
  getDbSchema,
  getValidDbSchemaTableNames,
  type DatabaseSchema,
} from "./db-schema";

/**
 * check if a table name is valid and return it
 */
export function getDbSchemaTable<K extends keyof DatabaseSchema>(
  tableName: K
): DatabaseSchema[K] {
  if (!Object.keys(getDb().query).includes(tableName)) {
    throw new Error(`Cannot find table name in drizzle schema: ${tableName}`);
  } else {
    const schema = getDbSchema();
    const key = tableName as keyof typeof schema;
    const table = schema[key];
    return table as DatabaseSchema[K];
  }
}

/**
 * Returns the table name in a camelCase format
 */
export const normalizeTableName = (name: string): keyof DatabaseSchema => {
  // replace '-'-string to a camelCase string
  const tableName = name.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
  if (!getValidDbSchemaTableNames().includes(tableName)) {
    throw new Error(`Invalid table name (normalized): ${name}/${tableName}`);
  }
  return tableName as keyof DatabaseSchema;
};
