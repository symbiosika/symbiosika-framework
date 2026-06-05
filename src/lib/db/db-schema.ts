import type { PgTableWithColumns } from "drizzle-orm/pg-core";
/**
 * Main Schema for the database
 */
import * as userTables from "./schema/users";
import * as secrets from "./schema/secrets";
import * as files from "./schema/files";
import * as additionalData from "./schema/additional-data";
import * as knowledge from "./schema/knowledge";
import * as jobs from "./schema/jobs";
import * as logs from "./schema/logs";
import * as webhooks from "./schema/webhooks";
import * as server from "./schema/server";
import * as apiTokens from "./schema/api-tokens";
import * as connections from "./schema/connections";
import * as oauthClients from "./schema/oauth-clients";
import * as oauthCodes from "./schema/oauth-codes";
import * as oauthRefreshTokens from "./schema/oauth-refresh-tokens";
import * as oauthConsents from "./schema/oauth-consents";
import * as emailLoginCodes from "./schema/email-login-codes";

// export all tables for drizzle-kit
export * from "./schema/users";
export * from "./schema/secrets";
export * from "./schema/files";
export * from "./schema/additional-data";
export * from "./schema/knowledge";
export * from "./schema/jobs";
export * from "./schema/logs";
export * from "./schema/webhooks";
export * from "./schema/server";
export * from "./schema/api-tokens";
export * from "./schema/connections";
export * from "./schema/oauth-clients";
export * from "./schema/oauth-codes";
export * from "./schema/oauth-refresh-tokens";
export * from "./schema/oauth-consents";
export * from "./schema/email-login-codes";

const baseDbSchema = {
  ...userTables,
  ...secrets,
  ...files,
  ...additionalData,
  ...knowledge,
  ...jobs,
  ...logs,
  ...webhooks,
  ...server,
  ...apiTokens,
  ...connections,
  ...oauthClients,
  ...oauthCodes,
  ...oauthRefreshTokens,
  ...oauthConsents,
  ...emailLoginCodes,
};

let validTableNames: string[] = [];

export const initializeFullDbSchema = (
  customSchema: Record<string, PgTableWithColumns<any>>
) => {
  Object.assign(baseDbSchema, customSchema);
  console.log("DB schema tables", Object.keys(baseDbSchema));
  validTableNames = Object.keys(baseDbSchema);
};

export const getValidDbSchemaTableNames = () => {
  return validTableNames;
};

export const getDbSchema = () => {
  return baseDbSchema;
};

/**
 * Export the database schema and the valid table names.
 */
export type DatabaseSchema = typeof baseDbSchema;
