/**
 * Generic CRUD route generation for resources
 * Replaces repetitive route files with standard Hono endpoints
 */

import { Hono } from "hono";
import { validator } from "hono-openapi";
import * as v from "valibot";
import { HTTPException } from "hono/http-exception";
import type { SFContextVariables } from "../../types";
import type { CrudOperations, QueryOptions } from "./types";

/**
 * Configuration for createCrudRoutes
 */
export interface CrudRoutesConfig {
  /** Route path prefix (e.g., "/tenant/:tenantId/competitors") */
  basePath: string;
  /** Singular entity name for error messages (e.g., "competitor") */
  entityName: string;
  /** Markdown export renderer */
  markdown?: {
    renderer: (entries: any[]) => string;
  };
}

/**
 * Parse query parameters into QueryOptions for getAll
 */
function parseQueryOptions(
  query: Record<string, string | undefined>
): QueryOptions {
  const options: QueryOptions = {};

  if (query.limit) {
    const parsed = parseInt(query.limit, 10);
    if (!isNaN(parsed) && parsed > 0) {
      options.limit = parsed;
    }
  }
  if (query.offset) {
    const parsed = parseInt(query.offset, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      options.offset = parsed;
    }
  }
  if (query.orderBy) {
    options.orderBy = query.orderBy;
  }
  if (query.orderDirection === "asc" || query.orderDirection === "desc") {
    options.orderDirection = query.orderDirection;
  }

  return options;
}

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
 * @example
 * ```typescript
 * const { registerRoutes } = createCrudRoutes(operations, {
 *   basePath: '/tenant/:tenantId/competitors',
 *   entityName: 'competitor',
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

  // GET / - List all entries with optional pagination and sorting
  app.get(
    "/",
    validator("param", v.object({ tenantId: v.string() })),
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
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
      validator("param", v.object({ tenantId: v.string() })),
      validator(
        "query",
        v.object({ type: v.optional(v.picklist(["text", "json"])) })
      ),
      async (c) => {
        try {
          const { tenantId } = c.req.valid("param");
          const { type = "text" } = c.req.valid("query");

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
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
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
    validator("param", v.object({ tenantId: v.string() })),
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
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
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
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
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
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
