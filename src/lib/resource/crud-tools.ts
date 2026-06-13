/**
 * Generic AI tool generation for resources
 * Replaces repetitive AI tool files with schema-derived tools
 */

import { tool } from "ai";
import { valibotSchema } from "@ai-sdk/valibot";
import * as v from "valibot";
import {
  withDescriptions,
  stripInternalFields,
  makeAllOptional,
} from "./schema-utils";
import type { CrudOperations } from "./types";

/**
 * Configuration for createCrudTools
 */
export interface CrudToolsConfig {
  /** Singular entity name (e.g., "competitor") */
  entityName: string;
  /** Plural entity name (e.g., "competitors") */
  entityNamePlural: string;
  /** Description for AI context */
  entityDescription: string;
  /** Valibot insert schema from drizzle-valibot */
  insertSchema: any;
  /** Semantic field descriptions */
  fieldDescriptions?: Record<string, string>;
}

/**
 * Capitalize first letter of a string
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Create AI tools for CRUD operations on a resource.
 * Returns a factory function that takes a tenantId and produces tools.
 *
 * Tool names follow the pattern: list<Plural>, get<Singular>, create<Singular>, update<Singular>, delete<Singular>
 *
 * @example
 * ```typescript
 * const toolFactory = createCrudTools(operations, {
 *   entityName: 'competitor',
 *   entityNamePlural: 'competitors',
 *   entityDescription: 'A competitor analysis entry',
 *   insertSchema: competitorsInsertSchema,
 *   fieldDescriptions: competitorsFieldDescriptions,
 * });
 *
 * // In chat route:
 * const tools = await toolFactory(tenantId);
 * // tools = { listCompetitors, getCompetitor, createCompetitor, updateCompetitor, deleteCompetitor }
 * ```
 */
export function createCrudTools(
  operations: CrudOperations,
  config: CrudToolsConfig
) {
  const {
    entityName,
    entityNamePlural,
    entityDescription,
    fieldDescriptions = {},
  } = config;
  const EntityName = capitalize(entityName);
  const EntityNamePlural = capitalize(entityNamePlural);

  // Prepare input schemas: strip internal fields and add descriptions
  const createInputSchema = withDescriptions(
    stripInternalFields(config.insertSchema),
    fieldDescriptions
  );

  const updateFieldsSchema = makeAllOptional(
    withDescriptions(stripInternalFields(config.insertSchema), fieldDescriptions)
  );

  /**
   * Factory function - creates tools scoped to a tenant
   */
  return async function createTools(
    tenantId: string
  ): Promise<Record<string, any>> {
    // List all entries
    const listTool = tool({
      description: `List all ${entityNamePlural} for the current tenant. ${entityDescription}`,
      inputSchema: valibotSchema(
        v.object({
          limit: v.optional(
            v.pipe(
              v.number(),
              v.description("Maximum number of results to return")
            )
          ),
          offset: v.optional(
            v.pipe(
              v.number(),
              v.description("Number of results to skip for pagination")
            )
          ),
          orderBy: v.optional(
            v.pipe(
              v.string(),
              v.description("Field name to order results by")
            )
          ),
          orderDirection: v.optional(
            v.pipe(
              v.picklist(["asc", "desc"]),
              v.description('Sort direction: "asc" or "desc"')
            )
          ),
        })
      ),
      execute: async ({ limit, offset, orderBy, orderDirection }) => {
        try {
          const entries = await operations.getAll(tenantId, {
            limit,
            offset,
            orderBy,
            orderDirection,
          });
          return { success: true, data: entries, count: entries.length };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : `Failed to list ${entityNamePlural}`,
          };
        }
      },
    });

    // Get single entry by ID
    const getTool = tool({
      description: `Get a single ${entityName} by its ID. ${entityDescription}`,
      inputSchema: valibotSchema(
        v.object({
          id: v.pipe(
            v.string(),
            v.description(
              `The ID of the ${entityName} to retrieve (required)`
            )
          ),
        })
      ),
      execute: async ({ id }) => {
        try {
          const entry = await operations.getById(tenantId, id);
          if (!entry) {
            return { success: false, error: `${EntityName} not found` };
          }
          return { success: true, data: entry };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : `Failed to get ${entityName}`,
          };
        }
      },
    });

    // Create new entry
    const createTool = tool({
      description: `Create a new ${entityName}. ${entityDescription}`,
      inputSchema: valibotSchema(createInputSchema),
      execute: async (input) => {
        try {
          const entry = await operations.create(tenantId, input);
          return { success: true, data: entry };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : `Failed to create ${entityName}`,
          };
        }
      },
    });

    // Update existing entry
    const updateTool = tool({
      description: `Update an existing ${entityName}. Only provide fields that should be changed.`,
      inputSchema: valibotSchema(
        v.object({
          id: v.pipe(
            v.string(),
            v.description(
              `The ID of the ${entityName} to update (required)`
            )
          ),
          ...updateFieldsSchema.entries,
        })
      ),
      execute: async ({ id, ...data }) => {
        try {
          // Filter out undefined values
          const updateData: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(data)) {
            if (value !== undefined) {
              updateData[key] = value;
            }
          }

          const entry = await operations.update(tenantId, id, updateData);
          if (!entry) {
            return { success: false, error: `${EntityName} not found` };
          }
          return { success: true, data: entry };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : `Failed to update ${entityName}`,
          };
        }
      },
    });

    // Delete entry
    const deleteTool = tool({
      description: `Delete a ${entityName} by its ID. This action cannot be undone.`,
      inputSchema: valibotSchema(
        v.object({
          id: v.pipe(
            v.string(),
            v.description(
              `The ID of the ${entityName} to delete (required)`
            )
          ),
        })
      ),
      execute: async ({ id }) => {
        try {
          const deleted = await operations.remove(tenantId, id);
          if (!deleted) {
            return { success: false, error: `${EntityName} not found` };
          }
          return {
            success: true,
            message: `${EntityName} deleted successfully`,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : `Failed to delete ${entityName}`,
          };
        }
      },
    });

    return {
      [`list${EntityNamePlural}`]: listTool,
      [`get${EntityName}`]: getTool,
      [`create${EntityName}`]: createTool,
      [`update${EntityName}`]: updateTool,
      [`delete${EntityName}`]: deleteTool,
    };
  };
}
