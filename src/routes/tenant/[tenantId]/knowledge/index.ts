/**
 * Routes for the RAG knowledge base (similarity search + re-embedding).
 *
 * Knowledge entries + chunks are the embedding mirror of wiki pages
 * (knowledgeText with `embeddingEnabled`). Managing entries, groups and the
 * old synchronous upload/parse flows has been removed; wiki pages are the
 * single source of truth and are ingested via `/knowledge/texts/*`.
 *
 * These routes are protected by JWT and CheckPermission middleware.
 */
import type { SymbiosikaFrameworkHonoApp } from "../../../../types";
import * as v from "valibot";
import { HTTPException } from "hono/http-exception";
import {
  getFullSourceDocumentsForSimilaritySearch,
  getNearestEmbeddings,
} from "../../../../lib/knowledge/similarity-search";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../lib/utils/hono-middlewares";
import { validateOrganisationId } from "../../../../lib/utils/doublecheck-tenant";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import { isTenantAdmin, isTenantMember } from "../..";
import { validateScope } from "../../../../lib/utils/validate-scope";
import { enqueueReEmbedding } from "../../../../lib/knowledge/re-embed";

const similaritySearchValidation = v.object({
  tenantId: v.string(),
  searchText: v.string(),
  n: v.optional(v.number()),
  addBeforeN: v.optional(v.number()),
  addAfterN: v.optional(v.number()),
  filterKnowledgeEntryIds: v.optional(v.array(v.string())),
  filterTeamIds: v.optional(v.array(v.string())),
  filterUserOwned: v.optional(v.boolean()),
  filterWorkspaceIds: v.optional(v.array(v.string())),
  filterName: v.optional(v.array(v.string())),
  fullDocument: v.optional(v.boolean()),
});

export default function defineRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH: string) {
  /**
   * Similarity search
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/similarity-search",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Search for similar documents",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("json", similaritySearchValidation),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const body = c.req.valid("json");
        const { tenantId } = c.req.valid("param");
        validateOrganisationId(body, tenantId);

        if (body.searchText.length < 3) {
          throw new Error("Search text must be at least 3 characters long");
        }

        if (body.fullDocument) {
          const r = await getFullSourceDocumentsForSimilaritySearch({
            tenantId: tenantId,
            searchText: body.searchText,
            n: body.n,
            filterKnowledgeEntryIds: body.filterKnowledgeEntryIds,
            filterName: body.filterName,
            userId,
          });
          return c.json(r);
        }

        const r = await getNearestEmbeddings({
          tenantId: tenantId,
          searchText: body.searchText,
          n: body.n,
          addBeforeN: body.addBeforeN,
          addAfterN: body.addAfterN,
          filterKnowledgeEntryIds: body.filterKnowledgeEntryIds,
          filterName: body.filterName,
        });
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Trigger re-embedding after an embedding model/provider change — enqueue
   * one background job per knowledge entry whose chunks are not on the
   * currently configured embedding model. Admin only. Safe to call repeatedly
   * (already queued/running entries are skipped).
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/re-embed",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Enqueue re-embed jobs for entries not on the configured embedding model",
      responses: {
        200: {
          description: "Enqueue result",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  enqueued: v.number(),
                  outdatedEntries: v.number(),
                })
              ),
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
      return c.json(await enqueueReEmbedding(tenantId));
    }
  );
}
