/**
 * Agent-facing and admin routes for the wiki (knowledge_text), grouped under
 * /tenant/:tenantId/wiki. These complement the page CRUD under
 * /tenant/:tenantId/knowledge/texts with the orientation-layer endpoints:
 *   - B3: controlled-facet vocabulary config (GET/PUT)
 *   - B1: summary backfill trigger (POST)
 *   - Teil A: resolve-by-title, recent-changes, batch-read, append, subtree
 *   - B2: wiki overview
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
   * B1: trigger a summary backfill — flag existing summary-less auto pages so
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
}
