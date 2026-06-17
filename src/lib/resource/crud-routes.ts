/**
 * Generic CRUD route generation for resources
 * Replaces repetitive route files with standard Hono endpoints
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { HTTPException } from "hono/http-exception";
import type { SFContextVariables } from "../../types";
import type { CrudAuthConfig, CrudOpenApiConfig, CrudOperations } from "./types";
import { parseQueryOptions } from "./query-params";
import { validateScope } from "../utils/validate-scope";
import { registerScopes } from "../auth/available-scopes";
import { isTenantAdmin, isTenantMember } from "../../routes/tenant";

/**
 * Configuration for createCrudRoutes
 */
export interface CrudRoutesConfig {
  /** Route path prefix (e.g., "/tenant/:tenantId/competitors") */
  basePath: string;
  /** Singular entity name for error messages (e.g., "competitor") */
  entityName: string;
  /** Plural resource name, used as the default OpenAPI tag (e.g. "competitors") */
  resourceName?: string;
  /** Markdown export renderer */
  markdown?: {
    renderer: (entries: any[]) => string;
  };
  /**
   * Authorization config: scope checks and tenant guards per action.
   * When omitted, every action requires tenant membership and has no scope check.
   */
  auth?: CrudAuthConfig;
  /** OpenAPI documentation config. */
  openapi?: CrudOpenApiConfig;
  /** Valibot schemas used to document request bodies and responses. */
  schemas?: {
    select?: any;
    insert?: any;
    update?: any;
  };
}

type CrudAction = "read" | "create" | "update" | "delete";

/**
 * Standard error handler for CRUD routes.
 * Handles HTTPException, ValiError, and custom validation errors consistently.
 */
function handleRouteError(
  c: any,
  error: unknown,
  operation: string,
  entityName: string
) {
  console.error(`Error ${operation} ${entityName}:`, error);

  if (error instanceof HTTPException) {
    throw error;
  }
  if (error instanceof v.ValiError) {
    return c.json({ success: false, error: "Validation error" }, 400);
  }
  // Handle custom validation errors with issues property (e.g., from hooks)
  if (error instanceof Error && (error as any).issues) {
    return c.json(
      { success: false, error: error.message || "Validation error" },
      400
    );
  }
  return c.json(
    { success: false, error: `Failed to ${operation} ${entityName}` },
    500
  );
}

/**
 * Create standard CRUD routes for a resource.
 * Generates GET /, GET /markdown (optional), GET /:id, POST /, PUT /:id, DELETE /:id
 *
 * Authorization (scopes + tenant guards) and OpenAPI docs are derived from the
 * `auth`, `openapi` and `schemas` config and applied per action.
 *
 * @example
 * ```typescript
 * const { registerRoutes } = createCrudRoutes(operations, {
 *   basePath: '/tenant/:tenantId/competitors',
 *   entityName: 'competitor',
 *   resourceName: 'competitors',
 *   auth: { scopePrefix: 'competitors', delete: { tenantGuard: 'admin' } },
 *   schemas: { select: competitorsSelectSchema, insert: competitorsInsertSchema, update: competitorsUpdateSchema },
 *   markdown: { renderer: renderCompetitorsMarkdown },
 * });
 * registerRoutes(app); // Register routes on a Hono app
 * ```
 */
export function createCrudRoutes(
  operations: CrudOperations,
  config: CrudRoutesConfig
) {
  const app = new Hono<{ Variables: SFContextVariables }>();
  const { entityName } = config;
  const resourceName = config.resourceName ?? entityName;

  const authConfig = config.auth ?? {};
  const defaultGuard = authConfig.tenantGuard ?? "member";

  // Resolve the scope required for an action: an explicit per-action scope wins,
  // otherwise the scopePrefix shorthand expands to `${prefix}:read|write`.
  const resolveScope = (
    action: CrudAction,
    kind: "read" | "write"
  ): string | undefined => {
    const explicit = authConfig[action]?.scope;
    if (explicit) return explicit;
    if (authConfig.scopePrefix) return `${authConfig.scopePrefix}:${kind}`;
    return undefined;
  };

  const resolveGuard = (action: CrudAction) =>
    authConfig[action]?.tenantGuard ?? defaultGuard;

  // Register every configured scope so it is accepted on token creation and
  // exposed in the OAuth2 discovery metadata.
  registerScopes(
    ...(
      [
        resolveScope("read", "read"),
        resolveScope("create", "write"),
        resolveScope("update", "write"),
        resolveScope("delete", "write"),
      ].filter(Boolean) as string[]
    )
  );

  // Build the auth middleware chain (scope check + tenant guard) for an action.
  const authChain = (
    action: CrudAction,
    kind: "read" | "write"
  ): MiddlewareHandler[] => {
    const chain: MiddlewareHandler[] = [];
    const scope = resolveScope(action, kind);
    if (scope) chain.push(validateScope(scope));
    const guard = resolveGuard(action);
    if (guard === "member") chain.push(isTenantMember);
    else if (guard === "admin") chain.push(isTenantAdmin);
    return chain;
  };

  // --- OpenAPI helpers --------------------------------------------------------
  const openapi = config.openapi ?? {};
  const openapiEnabled = openapi.enabled !== false;
  const tags = openapi.tags ?? [resourceName];
  const selectSchema = config.schemas?.select ?? openapi.selectSchema;
  const insertSchema = config.schemas?.insert;
  const updateSchema = config.schemas?.update;

  const successEnvelope = (dataSchema: any) =>
    v.object({ success: v.literal(true), data: dataSchema });

  // Build a describeRoute middleware (or nothing if docs are disabled).
  const doc = (spec: {
    summary: string;
    dataSchema?: any;
    bodySchema?: any;
  }): MiddlewareHandler[] => {
    if (!openapiEnabled) return [];

    const responses: Record<string, any> = {
      200: {
        description: "Successful response",
        ...(spec.dataSchema
          ? {
              content: {
                "application/json": {
                  schema: resolver(successEnvelope(spec.dataSchema)),
                },
              },
            }
          : {}),
      },
    };

    const route: Record<string, any> = {
      tags,
      summary: spec.summary,
      responses,
    };

    if (spec.bodySchema) {
      route.requestBody = {
        content: {
          "application/json": { schema: resolver(spec.bodySchema) },
        },
      };
    }

    return [describeRoute(route)];
  };

  // GET / - List entries with optional filtering, pagination, sorting and
  // relation expansion. Filters use PostgREST-style query params, e.g.
  //   ?status=eq.active&age=gte.18&name=like.john&expand=tenant&limit=20
  app.get(
    "/",
    ...doc({
      summary: `List ${resourceName}`,
      dataSchema: selectSchema ? v.array(selectSchema) : undefined,
    }),
    ...authChain("read", "read"),
    validator("param", v.object({ tenantId: v.string() })),
    async (c) => {
      try {
        const tenantId = c.req.param("tenantId")!;
        const rawQuery = c.req.query();
        const queryOptions = parseQueryOptions(rawQuery);

        const entries = await operations.getAll(tenantId, queryOptions);

        return c.json({
          success: true,
          data: entries,
        });
      } catch (error) {
        return handleRouteError(c, error, "fetching", entityName);
      }
    }
  );

  // GET /markdown - Markdown export for LLM context (optional)
  if (config.markdown) {
    const renderer = config.markdown.renderer;

    app.get(
      "/markdown",
      ...doc({ summary: `Export ${resourceName} as markdown` }),
      ...authChain("read", "read"),
      validator("param", v.object({ tenantId: v.string() })),
      validator(
        "query",
        v.object({ type: v.optional(v.picklist(["text", "json"])) })
      ),
      async (c) => {
        try {
          const tenantId = c.req.param("tenantId")!;
          const type = (c.req.query("type") as "text" | "json") ?? "text";

          const entries = await operations.getAll(tenantId);
          const markdownContent = renderer(entries);

          if (type === "json") {
            return c.json({ text: markdownContent });
          } else {
            return c.text(markdownContent, 200, {
              "Content-Type": "text/markdown; charset=utf-8",
            });
          }
        } catch (error) {
          return handleRouteError(
            c,
            error,
            "fetching",
            `${entityName} markdown`
          );
        }
      }
    );
  }

  // GET /:id - Get single entry
  app.get(
    "/:id",
    ...doc({ summary: `Get a ${entityName} by id`, dataSchema: selectSchema }),
    ...authChain("read", "read"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    async (c) => {
      try {
        const tenantId = c.req.param("tenantId")!;
        const id = c.req.param("id")!;
        const entry = await operations.getById(tenantId, id);

        if (!entry) {
          return c.json(
            { success: false, error: `${entityName} not found` },
            404
          );
        }

        return c.json({
          success: true,
          data: entry,
        });
      } catch (error) {
        return handleRouteError(c, error, "fetching", entityName);
      }
    }
  );

  // POST / - Create new entry
  app.post(
    "/",
    ...doc({
      summary: `Create a ${entityName}`,
      dataSchema: selectSchema,
      bodySchema: insertSchema,
    }),
    ...authChain("create", "write"),
    validator("param", v.object({ tenantId: v.string() })),
    async (c) => {
      try {
        const tenantId = c.req.param("tenantId")!;
        const body = await c.req.json();

        const newEntry = await operations.create(tenantId, body);

        return c.json({
          success: true,
          data: newEntry,
        });
      } catch (error) {
        return handleRouteError(c, error, "creating", entityName);
      }
    }
  );

  // PUT /:id - Update entry
  app.put(
    "/:id",
    ...doc({
      summary: `Update a ${entityName}`,
      dataSchema: selectSchema,
      bodySchema: updateSchema,
    }),
    ...authChain("update", "write"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    async (c) => {
      try {
        const tenantId = c.req.param("tenantId")!;
        const id = c.req.param("id")!;
        const body = await c.req.json();

        const updatedEntry = await operations.update(tenantId, id, body);

        if (!updatedEntry) {
          return c.json(
            { success: false, error: `${entityName} not found` },
            404
          );
        }

        return c.json({
          success: true,
          data: updatedEntry,
        });
      } catch (error) {
        return handleRouteError(c, error, "updating", entityName);
      }
    }
  );

  // DELETE /:id - Delete entry
  app.delete(
    "/:id",
    ...doc({ summary: `Delete a ${entityName}` }),
    ...authChain("delete", "write"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    async (c) => {
      try {
        const tenantId = c.req.param("tenantId")!;
        const id = c.req.param("id")!;
        const deleted = await operations.remove(tenantId, id);

        if (!deleted) {
          return c.json(
            { success: false, error: `${entityName} not found` },
            404
          );
        }

        return c.json({ success: true });
      } catch (error) {
        return handleRouteError(c, error, "deleting", entityName);
      }
    }
  );

  // Return the route registration function
  const registerRoutes = (honoApp: any) => {
    honoApp.route(config.basePath, app);
  };

  return { registerRoutes, app };
}
