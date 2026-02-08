/**
 * defineResource - Composable resource factory
 * Combines CRUD operations, API routes, and AI tools from a single configuration
 */

import type { PgTable, TableConfig } from "drizzle-orm/pg-core";
import { createCrudOperations } from "./crud-operations";
import { createCrudRoutes } from "./crud-routes";
import { createCrudTools } from "./crud-tools";
import type { ResourceConfig, ResourceDefinition } from "./types";

/**
 * Define a complete CRUD resource from a table definition and configuration.
 * Combines CRUD operations, API routes, and optional AI tools into one resource.
 *
 * This replaces ~600+ lines across lib, routes, and AI tool files
 * with a single ~25-40 line resource definition.
 *
 * @example
 * ```typescript
 * export const competitorsResource = defineResource({
 *   table: competitors,
 *   name: 'competitors',
 *   route: '/tenant/:tenantId/competitors',
 *   insertSchema: competitorsInsertSchema,
 *   updateSchema: competitorsUpdateSchema,
 *   fieldDescriptions: competitorsFieldDescriptions,
 *   defaultOrderBy: (t) => [desc(t.riskRating), asc(t.createdAt)],
 *   hooks: { beforeCreate: validateRiskRating },
 *   ai: { enabled: true, entityDescription: 'Competitor analysis entry' },
 *   markdown: { renderer: renderCompetitorsMarkdown },
 * });
 *
 * // Usage:
 * // competitorsResource.operations.getAll(tenantId)  -- Direct CRUD access
 * // competitorsResource.registerRoutes(app)           -- Register Hono routes
 * // competitorsResource.createTools(tenantId)          -- Get AI tools
 * ```
 */
export function defineResource<T extends PgTable<TableConfig>>(
  config: ResourceConfig<T>
): ResourceDefinition<T["$inferSelect"]> {
  // Derive entity names
  const entityNamePlural = config.ai?.entityNamePlural || config.name;
  const entityName =
    config.ai?.entityName ||
    (config.name.endsWith("s") ? config.name.slice(0, -1) : config.name);

  // 1. Create CRUD operations
  const operations = createCrudOperations(config.table, {
    insertSchema: config.insertSchema,
    updateSchema: config.updateSchema,
    defaultOrderBy: config.defaultOrderBy,
    hooks: config.hooks,
  });

  // 2. Create routes
  const { registerRoutes } = createCrudRoutes(operations, {
    basePath: config.route,
    entityName,
    markdown: config.markdown,
  });

  // 3. Create AI tools (optional)
  let createTools:
    | ((tenantId: string) => Promise<Record<string, any>>)
    | undefined;

  if (config.ai?.enabled) {
    createTools = createCrudTools(operations, {
      entityName,
      entityNamePlural,
      entityDescription: config.ai.entityDescription,
      insertSchema: config.insertSchema,
      fieldDescriptions: config.fieldDescriptions,
    });
  }

  return {
    operations,
    registerRoutes,
    createTools,
    config: config as unknown as ResourceConfig,
  };
}
