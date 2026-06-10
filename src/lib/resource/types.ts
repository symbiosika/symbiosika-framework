/**
 * Resource system types
 * Core type definitions for the composable CRUD resource pattern
 */

import type { PgTable, TableConfig } from "drizzle-orm/pg-core";

/**
 * Field descriptions for a table - used by AI tools and API docs.
 * Only actual column names can be described (type-safe via satisfies).
 *
 * @example
 * ```typescript
 * export const competitorsFieldDescriptions = {
 *   url: 'Website URL of the competitor',
 *   riskRating: 'Risk rating from 0 to 10',
 * } satisfies FieldDescriptions<typeof competitors>;
 * ```
 */
export type FieldDescriptions<T extends PgTable<TableConfig>> = Partial<
  Record<keyof T["$inferInsert"] & string, string>
>;

/**
 * Filter operators for querying
 */
export type FilterOperator = "eq" | "like" | "gte" | "lte" | "in";

/**
 * A single query filter
 */
export interface QueryFilter {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

/**
 * Options for getAll queries - filtering, pagination, sorting, relation expansion
 */
export interface QueryOptions {
  filters?: QueryFilter[];
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: "asc" | "desc";
  /**
   * Names of relations to eager-load alongside each entry.
   * Only relations declared in the resource's `relations.allowed` list are
   * expanded; unknown names are ignored. Requires `relations` to be configured.
   */
  expand?: string[];
}

/**
 * Relation expansion config for a resource.
 *
 * Expansion uses Drizzle's relational query API
 * (`db.query.<queryKey>.findMany({ with })`), which requires the table's
 * `relations()` to be registered in the schema.
 */
export interface ResourceRelationsConfig {
  /**
   * The table's key in the Drizzle schema as exposed on `db.query`.
   * This is the JS property name the table is registered under, which may
   * differ from the SQL table name (e.g. `knowledgeEntry`, not `knowledge`).
   */
  queryKey: string;
  /**
   * Relation names that callers may request via `?expand=`.
   * Acts as an allow-list: any requested relation not in this list is ignored.
   */
  allowed: string[];
}

/**
 * Lifecycle hooks for CRUD operations.
 * Hooks can modify data (beforeCreate/beforeUpdate) or perform side effects.
 * Throwing an error from a hook prevents the operation.
 */
export interface CrudHooks {
  beforeCreate?: (
    data: Record<string, unknown>
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  afterCreate?: (entry: Record<string, unknown>) => void | Promise<void>;
  beforeUpdate?: (
    data: Record<string, unknown>
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  afterUpdate?: (entry: Record<string, unknown>) => void | Promise<void>;
  beforeDelete?: (id: string) => void | Promise<void>;
  afterDelete?: (id: string) => void | Promise<void>;
}

/**
 * CRUD operations returned by createCrudOperations
 */
export interface CrudOperations<TSelect = any> {
  getAll: (tenantId: string, options?: QueryOptions) => Promise<TSelect[]>;
  getById: (tenantId: string, id: string) => Promise<TSelect | null>;
  create: (tenantId: string, data: unknown) => Promise<TSelect>;
  update: (
    tenantId: string,
    id: string,
    data: unknown
  ) => Promise<TSelect | null>;
  remove: (tenantId: string, id: string) => Promise<boolean>;
}

/**
 * Full resource definition config
 */
export interface ResourceConfig<
  T extends PgTable<TableConfig> = PgTable<TableConfig>,
> {
  /** The Drizzle table definition */
  table: T;
  /** Resource name (plural, lowercase, e.g., "competitors") */
  name: string;
  /** Route path (e.g., "/tenant/:tenantId/competitors") */
  route: string;
  /** Valibot insert schema from drizzle-valibot */
  insertSchema: any;
  /** Valibot update schema from drizzle-valibot */
  updateSchema: any;
  /** Semantic field descriptions for AI tools and API docs */
  fieldDescriptions?: Record<string, string>;
  /** Default ordering for getAll queries */
  defaultOrderBy?: (table: T) => any[];
  /** Lifecycle hooks for business rules */
  hooks?: CrudHooks;
  /**
   * Relation expansion config. When set, callers can request related rows via
   * `?expand=relationName` on the list endpoint. Requires the table's
   * `relations()` to be registered in the Drizzle schema.
   */
  relations?: ResourceRelationsConfig;
  /** AI tool configuration */
  ai?: {
    enabled: boolean;
    /** Singular entity name (defaults to name without trailing 's') */
    entityName?: string;
    /** Plural entity name (defaults to name) */
    entityNamePlural?: string;
    /** Description for AI tool context */
    entityDescription: string;
  };
  /** Markdown export configuration */
  markdown?: {
    renderer: (entries: any[]) => string;
  };
}

/**
 * A resource definition returned by defineResource
 */
export interface ResourceDefinition<TSelect = any> {
  /** CRUD operation functions */
  operations: CrudOperations<TSelect>;
  /** Register Hono routes on an app */
  registerRoutes: (app: any) => void;
  /** Factory function to create AI tools for a given tenant */
  createTools?: (tenantId: string) => Promise<Record<string, any>>;
  /** The original config */
  config: ResourceConfig;
}
