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
 * Tenant access guard applied to a CRUD action.
 * - "member": caller must be a member of the route's tenant (default)
 * - "admin":  caller must be an admin or owner of the route's tenant
 * - "none":   no tenant membership check (the operation still scopes by tenantId)
 */
export type TenantGuard = "member" | "admin" | "none";

/** Per-action authorization config. */
export interface CrudActionAuth {
  /**
   * Required scope for this action (e.g. "robots:read"). When set, a
   * validateScope() middleware is applied to the route and the scope is
   * registered as an available scope automatically.
   */
  scope?: string;
  /** Tenant access guard for this action. Defaults to the group default. */
  tenantGuard?: TenantGuard;
}

/**
 * Authorization config for generated CRUD routes.
 *
 * Actions map to routes as follows:
 * - `read`   -> GET (list), GET /:id, GET /markdown
 * - `create` -> POST /
 * - `update` -> PUT /:id
 * - `delete` -> DELETE /:id
 */
export interface CrudAuthConfig {
  /**
   * Scope prefix shorthand. Expands to `${prefix}:read` for read actions and
   * `${prefix}:write` for create/update/delete actions, unless a per-action
   * `scope` overrides it. All resulting scopes are registered automatically.
   */
  scopePrefix?: string;
  /** Default tenant guard for every action. Defaults to "member". */
  tenantGuard?: TenantGuard;
  /** Per-action override for the read actions (list, getById, markdown). */
  read?: CrudActionAuth;
  /** Per-action override for create (POST). */
  create?: CrudActionAuth;
  /** Per-action override for update (PUT). */
  update?: CrudActionAuth;
  /** Per-action override for delete (DELETE). */
  delete?: CrudActionAuth;
}

/** OpenAPI documentation config for generated CRUD routes. */
export interface CrudOpenApiConfig {
  /** Emit OpenAPI docs via describeRoute. Defaults to true. */
  enabled?: boolean;
  /** OpenAPI tags for grouping. Defaults to the resource name. */
  tags?: string[];
  /**
   * Valibot select schema used to document successful responses. Falls back to
   * the resource's select schema when omitted.
   */
  selectSchema?: any;
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
  /** Valibot select schema from drizzle-valibot, used for response docs */
  selectSchema?: any;
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
  /**
   * Authorization for generated routes: scope checks and tenant guards per
   * action. When omitted, routes require tenant membership ("member") and have
   * no scope check.
   */
  auth?: CrudAuthConfig;
  /** OpenAPI documentation config for generated routes. */
  openapi?: CrudOpenApiConfig;
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
