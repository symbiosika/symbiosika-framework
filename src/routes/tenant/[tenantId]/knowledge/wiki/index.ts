/**
 * Agent-facing and admin routes for the wiki (knowledge_text), grouped under
 * /tenant/:tenantId/wiki. These complement the page CRUD under
 * /tenant/:tenantId/knowledge/texts with the orientation-layer endpoints:
 *   - controlled-facet vocabulary config (GET/PUT)
 *   - summary backfill trigger (POST)
 *   - resolve-by-title, recent-changes, batch-read, append, subtree
 *   - wiki overview
 *
 * All routes go through the standard auth + tenant-membership chain, so the
 * existing visibility mechanics apply.
 */
import type { SymbiosikaFrameworkHonoApp } from "../../../../../types";
import * as v from "valibot";
import { HTTPException } from "hono/http-exception";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../../lib/utils/hono-middlewares";
import { validateScope } from "../../../../../lib/utils/validate-scope";
import { isTenantMember, isTenantAdmin } from "../../..";
import {
  getWikiTenantConfig,
  setWikiTenantConfig,
} from "../../../../../lib/knowledge/wiki-config";
import { enqueueSummaryBackfill } from "../../../../../lib/knowledge/summaries";
import {
  resolvePageByTitle,
  listRecentChanges,
  getPagesBatch,
} from "../../../../../lib/knowledge/knowledge-text-agent";
import { getWikiOverview } from "../../../../../lib/knowledge/wiki-overview";

const wikiConfigSchema = v.object({
  autoSummaries: v.boolean(),
  pageTypes: v.array(v.string()),
  statuses: v.array(v.string()),
});

const wikiConfigPatchSchema = v.object({
  autoSummaries: v.optional(v.boolean()),
  pageTypes: v.optional(v.array(v.string())),
  statuses: v.optional(v.array(v.string())),
});

export default function defineWikiRoutes(
  app: SymbiosikaFrameworkHonoApp,
  API_BASE_PATH: string
) {
  const base = API_BASE_PATH + "/tenant/:tenantId/wiki";

  /**
   * wiki overview — the briefing an agent loads at session start. Metrics,
   * top-level structure with summaries/facets, recent changes, and the embedded
   * agent-instructions page.
   */
  app.get(
    base + "/overview",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["wiki"],
      summary: "Get the wiki overview (metrics, top-level, recent, instructions)",
      responses: { 200: { description: "Wiki overview" } },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string() })),
    validator("query", v.object({ recentLimit: v.optional(v.string()) })),
    isTenantMember,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      const { recentLimit } = c.req.valid("query");
      const userId = c.get("usersId");
      const overview = await getWikiOverview(
        { tenantId, userId },
        { recentLimit: recentLimit ? parseInt(recentLimit) : undefined }
      );
      return c.json(overview);
    }
  );

  /**
   * Get the tenant's wiki config (facet vocabularies + auto-summary switch).
   */
  app.get(
    base + "/config",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["wiki"],
      summary: "Get the tenant wiki configuration (facet vocabularies, flags)",
      responses: {
        200: {
          description: "Wiki configuration",
          content: {
            "application/json": { schema: resolver(wikiConfigSchema) },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      return c.json(await getWikiTenantConfig(tenantId));
    }
  );

  /**
   * Update the tenant's wiki config. Admin only (it changes the controlled
   * vocabulary and cost/privacy-relevant auto-summary switch).
   */
  app.put(
    base + "/config",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["wiki"],
      summary: "Update the tenant wiki configuration",
      responses: {
        200: {
          description: "Updated wiki configuration",
          content: {
            "application/json": { schema: resolver(wikiConfigSchema) },
          },
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("param", v.object({ tenantId: v.string() })),
    validator("json", wikiConfigPatchSchema),
    isTenantAdmin,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      const patch = c.req.valid("json");
      return c.json(await setWikiTenantConfig(tenantId, patch));
    }
  );

  /**
   * trigger a summary backfill — flag existing summary-less auto pages so
   * the debounced sweeper generates them. Admin only. Returns the number of
   * pages flagged.
   */
  app.post(
    base + "/summaries/backfill",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["wiki"],
      summary: "Flag summary-less pages for background summary generation",
      responses: {
        200: {
          description: "Backfill result",
          content: {
            "application/json": {
              schema: resolver(v.object({ flagged: v.number() })),
            },
          },
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantAdmin,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      try {
        return c.json(await enqueueSummaryBackfill(tenantId));
      } catch (e) {
        throw new HTTPException(500, { message: `${e}` });
      }
    }
  );

  /**
   * resolve a page by exact title (case-insensitive, wikilink semantics).
   * Returns the page ref (without text) or 404.
   */
  app.get(
    base + "/resolve",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["wiki"],
      summary: "Resolve a wiki page by its exact title",
      responses: { 200: { description: "Resolved page (without text)" } },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string() })),
    validator("query", v.object({ title: v.string() })),
    isTenantMember,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      const { title } = c.req.valid("query");
      const userId = c.get("usersId");
      const page = await resolvePageByTitle(title, { tenantId, userId });
      if (!page) throw new HTTPException(404, { message: "Page not found" });
      return c.json(page);
    }
  );

  /**
   * recent changes — visible pages newest-first, without text, filterable
   * by time window, subtree (parentId) and facets. Each item carries
   * summary + facets + updatedAt + updatedBy.
   */
  app.get(
    base + "/recent-changes",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["wiki"],
      summary: "List recently changed wiki pages",
      responses: { 200: { description: "Recently changed pages (no text)" } },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string() })),
    validator(
      "query",
      v.object({
        since: v.optional(v.string()),
        parentId: v.optional(v.string()),
        pageType: v.optional(v.string()),
        status: v.optional(v.string()),
        teamId: v.optional(v.string()),
        limit: v.optional(v.string()),
      })
    ),
    isTenantMember,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      const q = c.req.valid("query");
      const userId = c.get("usersId");
      const r = await listRecentChanges(
        { tenantId, userId, teamId: q.teamId },
        {
          since: q.since,
          parentId: q.parentId,
          pageType: q.pageType,
          status: q.status,
          limit: q.limit ? parseInt(q.limit) : undefined,
        }
      );
      return c.json(r);
    }
  );

  /**
   * batch-read several pages in one call. Body: { ids, includeText? }.
   * Pages the caller cannot see are silently dropped.
   */
  app.post(
    base + "/pages",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["wiki"],
      summary: "Read several wiki pages by id in one request",
      responses: { 200: { description: "Requested visible pages" } },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string() })),
    validator(
      "json",
      v.object({
        ids: v.array(v.string()),
        includeText: v.optional(v.boolean()),
      })
    ),
    isTenantMember,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      const { ids, includeText } = c.req.valid("json");
      const userId = c.get("usersId");
      const r = await getPagesBatch(ids, { tenantId, userId }, { includeText });
      return c.json(r);
    }
  );
}
