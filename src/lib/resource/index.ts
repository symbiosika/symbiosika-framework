/**
 * Resource system - Composable CRUD resource pattern
 *
 * Provides building blocks to eliminate CRUD boilerplate:
 * - createCrudOperations: Generic business logic with filtering, pagination, hooks
 * - createCrudRoutes: Standard Hono API routes with error handling
 * - createCrudTools: AI tools derived from table schemas
 * - defineResource: Combines all three into a single resource definition
 *
 * Each utility is usable independently or combined through defineResource().
 */

// Types
export type {
  FieldDescriptions,
  FilterOperator,
  QueryFilter,
  QueryOptions,
  ResourceRelationsConfig,
  CrudHooks,
  CrudOperations,
  ResourceConfig,
  ResourceDefinition,
} from "./types";

// URL query parsing (filtering, pagination, sorting, relation expansion)
export {
  parseQueryOptions,
  parseFilterParams,
  parseExpandParam,
  parseFilterValue,
  RESERVED_QUERY_KEYS,
} from "./query-params";

// Schema utilities
export {
  withDescriptions,
  stripInternalFields,
  makeAllOptional,
} from "./schema-utils";

// CRUD operations
export { createCrudOperations } from "./crud-operations";
export type { CrudOperationsConfig } from "./crud-operations";

// CRUD routes
export { createCrudRoutes } from "./crud-routes";
export type { CrudRoutesConfig } from "./crud-routes";

// AI tools
export { createCrudTools } from "./crud-tools";
export type { CrudToolsConfig } from "./crud-tools";

// Resource factory
export { defineResource } from "./define-resource";
