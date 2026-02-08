/**
 * Generic CRUD operations for tenant-scoped resources
 * Replaces repetitive lib/*.ts business logic files
 */

import { getDb } from "../db/db-connection";
import {
  SQL,
  and,
  eq,
  ilike,
  gte,
  lte,
  inArray,
  asc,
  desc,
  getTableColumns,
} from "drizzle-orm";
import type { PgTable, TableConfig } from "drizzle-orm/pg-core";
import * as v from "valibot";
import type {
  CrudOperations,
  CrudHooks,
  QueryOptions,
  QueryFilter,
} from "./types";

/**
 * Configuration for createCrudOperations
 */
export interface CrudOperationsConfig<T extends PgTable<TableConfig>> {
  /** Valibot insert schema from drizzle-valibot */
  insertSchema: any;
  /** Valibot update schema from drizzle-valibot */
  updateSchema: any;
  /** Default ordering for getAll queries */
  defaultOrderBy?: (table: T) => any[];
  /** Lifecycle hooks for business rules */
  hooks?: CrudHooks;
}

/**
 * Build filter conditions from QueryFilter array.
 * Validates field names against actual table columns for security.
 */
function buildFilterConditions<T extends PgTable<TableConfig>>(
  table: T,
  filters: QueryFilter[]
): SQL[] {
  const columns = getTableColumns(table);
  const conditions: SQL[] = [];

  for (const filter of filters) {
    const column = columns[filter.field as keyof typeof columns];
    if (!column) continue; // Skip invalid fields (security)

    switch (filter.operator) {
      case "eq":
        conditions.push(eq(column, filter.value));
        break;
      case "like":
        conditions.push(ilike(column, `%${filter.value}%`));
        break;
      case "gte":
        conditions.push(gte(column, filter.value));
        break;
      case "lte":
        conditions.push(lte(column, filter.value));
        break;
      case "in":
        conditions.push(inArray(column, filter.value as any[]));
        break;
    }
  }

  return conditions;
}

/**
 * Create generic CRUD operations for any tenant-scoped table.
 * Supports filtering, pagination, sorting, and lifecycle hooks.
 *
 * @example
 * ```typescript
 * const ops = createCrudOperations(competitors, {
 *   insertSchema: competitorsInsertSchema,
 *   updateSchema: competitorsUpdateSchema,
 *   defaultOrderBy: (t) => [desc(t.riskRating), asc(t.createdAt)],
 *   hooks: { beforeCreate: validateRiskRating },
 * });
 * ```
 */
export function createCrudOperations<T extends PgTable<TableConfig>>(
  table: T,
  config: CrudOperationsConfig<T>
): CrudOperations<T["$inferSelect"]> {
  const columns = getTableColumns(table);
  const tenantIdCol = columns["tenantId" as keyof typeof columns] as any;
  const idCol = columns["id" as keyof typeof columns] as any;

  if (!tenantIdCol) {
    throw new Error(
      "Table must have a 'tenantId' column for resource operations"
    );
  }
  if (!idCol) {
    throw new Error("Table must have an 'id' column for resource operations");
  }

  /**
   * Get all entries for a tenant with optional filtering, pagination, and sorting
   */
  async function getAll(
    tenantId: string,
    options: QueryOptions = {}
  ): Promise<T["$inferSelect"][]> {
    const {
      filters = [],
      limit,
      offset,
      orderBy,
      orderDirection = "asc",
    } = options;

    // @ts-expect-error - Drizzle's from() uses a deferred conditional type
    // that TypeScript cannot resolve with generic PgTable type params
    let query = getDb().select().from(table).$dynamic();

    // Always filter by tenant
    const conditions: SQL[] = [eq(tenantIdCol, tenantId)];

    // Add custom filters
    if (filters.length > 0) {
      conditions.push(...buildFilterConditions(table, filters));
    }

    query = query.where(and(...conditions));

    // Sorting
    if (orderBy) {
      const orderCol = columns[orderBy as keyof typeof columns];
      if (orderCol) {
        query = query.orderBy(
          orderDirection === "desc" ? desc(orderCol) : asc(orderCol)
        );
      }
    } else if (config.defaultOrderBy) {
      query = query.orderBy(...config.defaultOrderBy(table));
    }

    // Pagination
    if (limit !== undefined) {
      query = query.limit(limit);
    }
    if (offset !== undefined) {
      query = query.offset(offset);
    }

    return query;
  }

  /**
   * Get a single entry by ID for a tenant
   */
  async function getById(
    tenantId: string,
    id: string
  ): Promise<T["$inferSelect"] | null> {
    const result = await getDb()
      .select()
      // @ts-expect-error - Drizzle generic typing limitation
      .from(table)
      .where(and(eq(idCol, id), eq(tenantIdCol, tenantId)))
      .limit(1);

    return result.length > 0 ? (result[0] as T["$inferSelect"]) : null;
  }

  /**
   * Create a new entry
   */
  async function create(
    tenantId: string,
    data: unknown
  ): Promise<T["$inferSelect"]> {
    // Validate input with insert schema
    let validatedData = v.parse(config.insertSchema, {
      ...(data as Record<string, unknown>),
      tenantId,
    });

    // Run beforeCreate hook
    if (config.hooks?.beforeCreate) {
      validatedData = await config.hooks.beforeCreate(
        validatedData as Record<string, unknown>
      );
    }

    const result = await getDb()
      .insert(table)
      .values(validatedData as any)
      .returning();

    const entry = result[0]!;

    // Run afterCreate hook
    if (config.hooks?.afterCreate) {
      await config.hooks.afterCreate(entry as Record<string, unknown>);
    }

    return entry;
  }

  /**
   * Update an existing entry
   */
  async function update(
    tenantId: string,
    id: string,
    data: unknown
  ): Promise<T["$inferSelect"] | null> {
    // Check existence
    const existing = await getById(tenantId, id);
    if (!existing) return null;

    // Validate input with update schema
    let validatedData = v.parse(config.updateSchema, data);

    // Run beforeUpdate hook
    if (config.hooks?.beforeUpdate) {
      validatedData = await config.hooks.beforeUpdate(
        validatedData as Record<string, unknown>
      );
    }

    const updatedAtCol = columns["updatedAt" as keyof typeof columns];
    const setData: Record<string, unknown> = {
      ...(validatedData as Record<string, unknown>),
    };
    if (updatedAtCol) {
      setData.updatedAt = new Date().toISOString();
    }

    const result = await getDb()
      .update(table)
      .set(setData as any)
      .where(and(eq(idCol, id), eq(tenantIdCol, tenantId)))
      .returning();

    const entry = result.length > 0 ? result[0]! : null;

    // Run afterUpdate hook
    if (entry && config.hooks?.afterUpdate) {
      await config.hooks.afterUpdate(entry as Record<string, unknown>);
    }

    return entry;
  }

  /**
   * Delete an entry
   */
  async function remove(tenantId: string, id: string): Promise<boolean> {
    // Check existence
    const existing = await getById(tenantId, id);
    if (!existing) return false;

    // Run beforeDelete hook
    if (config.hooks?.beforeDelete) {
      await config.hooks.beforeDelete(id);
    }

    await getDb()
      .delete(table as any)
      .where(and(eq(idCol, id), eq(tenantIdCol, tenantId)));

    // Run afterDelete hook
    if (config.hooks?.afterDelete) {
      await config.hooks.afterDelete(id);
    }

    return true;
  }

  return { getAll, getById, create, update, remove };
}
