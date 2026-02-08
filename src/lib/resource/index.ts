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
  CrudHooks,
  CrudOperations,
  ResourceConfig,
  ResourceDefinition,
} from "./types";

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
