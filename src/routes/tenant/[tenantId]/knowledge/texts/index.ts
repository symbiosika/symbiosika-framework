/**
 * Routes to manage the knowledge entries for each tenant
 * These routes are protected by JWT and CheckPermission middleware
 */
import type { SymbiosikaFrameworkHonoApp } from "../../../../../types";
import * as v from "valibot";
import { HTTPException } from "hono/http-exception";
import { RESPONSES } from "../../../../../lib/responses";
import {
  createKnowledgeText,
  getKnowledgeText,
  getKnowledgeTextById,
  getKnowledgeTextHistory,
  getKnowledgeTextHistoryVersion,
  updateKnowledgeText,
  deleteKnowledgeText,
} from "../../../../../lib/knowledge/knowledge-texts";
import {
  getKnowledgeTextBlocks,
  syncKnowledgeTextBlocks,
  convertKnowledgeTextToBlocks,
} from "../../../../../lib/knowledge/knowledge-text-blocks";
import { getSimplifiedKnowledgeText } from "../../../../../lib/knowledge/knowledge-text-simplified";
import {
  readKnowledgeTextContent,
  editKnowledgeTextContent,
} from "../../../../../lib/knowledge/knowledge-text-edit";
import {
  appendToKnowledgeText,
  resolvePageByTitle,
  listRecentChanges,
  getPagesBatch,
} from "../../../../../lib/knowledge/knowledge-text-agent";
import {
  getKnowledgeTenantConfig,
  setKnowledgeTenantConfig,
} from "../../../../../lib/knowledge/knowledge-config";
import { enqueueSummaryBackfill } from "../../../../../lib/knowledge/summaries";
import { getUsedAttributeValues } from "../../../../../lib/knowledge/knowledge-texts";
import { getKnowledgeOverview } from "../../../../../lib/knowledge/knowledge-overview";
import {
  getPageOutline,
  readPageSection,
} from "../../../../../lib/knowledge/knowledge-text-sections";
import { searchKnowledgeTexts } from "../../../../../lib/knowledge/knowledge-text-search";
import { getPageChunkContext } from "../../../../../lib/knowledge/knowledge-text-chunks";
import {
  getKnowledgeTextLinks,
  getKnowledgeTextBacklinks,
  getRelatedKnowledgeTexts,
} from "../../../../../lib/knowledge/knowledge-text-links";
import {
  createKnowledgeIngestJob,
  storeIngestFileInDb,
} from "../../../../../lib/knowledge/ingestion-jobs";
import {
  upsertKnowledgeTextFromSource,
  deleteOrphanedKnowledgeTexts,
} from "../../../../../lib/knowledge/knowledge-text-sync";
import { uploadKnowledgeTextImage } from "../../../../../lib/knowledge/knowledge-text-files";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../../lib/utils/hono-middlewares";
import { validateOrganisationId } from "../../../../../lib/utils/doublecheck-tenant";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import {
  knowledgeEntrySchema,
  knowledgeTextInsertSchema,
  knowledgeTextUpdateSchema,
  knowledgeTextBlockSchema,
  jobsSelectSchema,
} from "../../../../../lib/db/db-schema";
import { isTenantMember, isTenantAdmin } from "../../..";
import { validateScope } from "../../../../../lib/utils/validate-scope";

/**
 * Parse the `attributes` filter query param: a URL-encoded JSON object of
 * string values, e.g. attributes={"hersteller":"Miele","typ":"Datenblatt"}.
 * All entries are combined with AND.
 */
const parseAttributesFilter = (
  raw?: string
): Record<string, string> | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((value) => typeof value === "string")
    ) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through to the error below
  }
  throw new HTTPException(400, {
    message:
      'Invalid "attributes" filter — expected a JSON object of string values, e.g. {"hersteller":"Miele"}',
  });
};

const blockInputSchema = v.object({
  id: v.optional(v.pipe(v.string(), v.uuid())),
  type: v.picklist(["markdown", "html"]),
  content: v.string(),
  meta: v.optional(v.record(v.string(), v.unknown())),
});

const syncBlocksBodySchema = v.object({
  blocks: v.array(blockInputSchema),
});

const contextQuerySchema = v.object({
  teamId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  includeHidden: v.optional(v.string()),
});

const simplifiedKnowledgeTextSchema: v.GenericSchema = v.object({
  id: v.string(),
  title: v.string(),
  content: v.string(),
  children: v.optional(
    v.array(v.lazy(() => simplifiedKnowledgeTextSchema))
  ),
});

export default function defineRoutesForKnowledgeTexts(
  app: SymbiosikaFrameworkHonoApp,
  API_BASE_PATH: string
) {
  /**
   * Create a new knowledge text entry
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Create a new knowledge text entry",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("json", knowledgeTextInsertSchema),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const body = c.req.valid("json");
        const { tenantId } = c.req.valid("param");
        validateOrganisationId(body, tenantId);

        const usersId = c.get("usersId");
        const r = await createKnowledgeText({
          ...body,
          userId: usersId,
          // audit: track who created / last changed the entry
          createdBy: usersId,
          updatedBy: usersId,
        });
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Get list of knowledge text entries (returns only latest versions WITHOUT text content)
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Get list of knowledge text entries (returns only latest versions WITHOUT text content)",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(v.array(knowledgeEntrySchema)),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "query",
      v.object({
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        limit: v.optional(v.string()),
        page: v.optional(v.string()),
        includeHidden: v.optional(v.string()),
        // facet filters
        pageType: v.optional(v.string()),
        status: v.optional(v.string()),
        // JSON object of attribute equality filters (AND-combined)
        attributes: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const {
          teamId,
          workspaceId,
          limit: limitStr,
          page: pageStr,
          includeHidden: includeHiddenStr,
          pageType,
          status,
          attributes: attributesStr,
        } = c.req.valid("query");
        const { tenantId } = c.req.valid("param");
        const userId = c.get("usersId");
        const limit = limitStr ? parseInt(limitStr) : undefined;
        const page = pageStr ? parseInt(pageStr) : undefined;
        const includeHidden = includeHiddenStr === "true";

        const r = await getKnowledgeText({
          limit,
          page,
          tenantId,
          userId,
          teamId,
          workspaceId,
          includeHidden,
          pageType,
          status,
          attributes: parseAttributesFilter(attributesStr),
        });
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Import an uploaded file (markdown, html, txt, PDF, …) as a wiki page.
   * NOTE: registered before GET/POST /texts/:id-style routes on purpose —
   * hono matches in registration order.
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/import",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Start a background job to import a file (markdown, html, txt, PDF, ...) as a knowledge text wiki page (returns the Job)",
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: v.object({
              file: v.any(),
              title: v.optional(v.string()),
              parentId: v.optional(v.string()),
              teamId: v.optional(v.string()),
              tenantWide: v.optional(v.string()),
              embeddingEnabled: v.optional(v.string()),
              splitIntoBlocks: v.optional(v.string()),
              usePostProcessors: v.optional(v.string()),
            }),
          },
        },
      },
      responses: {
        200: {
          description: "The created ingestion job",
          content: {
            "application/json": {
              schema: resolver(jobsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const userId = c.get("usersId");
        const form = await c.req.formData();

        const file = form.get("file");
        if (!(file instanceof File)) {
          throw new Error("Missing 'file' form field");
        }

        // Stash the file so the background job can read it later; the job
        // deletes the temporary file when it is done.
        const storage = await storeIngestFileInDb(file, tenantId);
        const job = await createKnowledgeIngestJob(
          {
            kind: "text-import-file",
            tenantId,
            userId,
            notifyOnCompletion:
              form.get("notifyOnCompletion")?.toString() === "true",
            storage,
            deleteAfter: true,
            options: {
              title: form.get("title")?.toString() || undefined,
              parentId: form.get("parentId")?.toString() || undefined,
              teamId: form.get("teamId")?.toString() || undefined,
              tenantWide: form.get("tenantWide")?.toString() === "true",
              embeddingEnabled:
                form.get("embeddingEnabled")?.toString() === "true",
              splitIntoBlocks:
                form.get("splitIntoBlocks")?.toString() !== "false",
              usePostProcessors: form
                .get("usePostProcessors")
                ?.toString()
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            },
          },
          tenantId,
          userId
        );
        return c.json(job);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Import a web page as a wiki page (Readability + Turndown, SSRF-guarded)
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/import-url",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Start a background job to import a web page as a knowledge text wiki page (returns the Job)",
      responses: {
        200: {
          description: "The created ingestion job",
          content: {
            "application/json": {
              schema: resolver(jobsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:write"),
    validator(
      "json",
      v.object({
        url: v.pipe(v.string(), v.url()),
        title: v.optional(v.string()),
        parentId: v.optional(v.string()),
        teamId: v.optional(v.string()),
        tenantWide: v.optional(v.boolean()),
        embeddingEnabled: v.optional(v.boolean()),
        splitIntoBlocks: v.optional(v.boolean()),
        usePostProcessors: v.optional(v.array(v.string())),
        notifyOnCompletion: v.optional(v.boolean()),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const userId = c.get("usersId");
        const body = c.req.valid("json");

        const job = await createKnowledgeIngestJob(
          {
            kind: "text-import-url",
            tenantId,
            userId,
            notifyOnCompletion: body.notifyOnCompletion,
            params: {
              url: body.url,
              options: {
                title: body.title,
                parentId: body.parentId,
                teamId: body.teamId,
                tenantWide: body.tenantWide,
                embeddingEnabled: body.embeddingEnabled,
                splitIntoBlocks: body.splitIntoBlocks,
                usePostProcessors: body.usePostProcessors,
              },
            },
          },
          tenantId,
          userId
        );
        return c.json(job);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Batch-sync pages from an external source. Each item is upserted by its
   * stable sourceIdentifier; optionally deletes synced pages that vanished
   * from the source (never touches hand-written pages).
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/sync",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Batch-sync wiki pages from an external source (upsert by sourceIdentifier, optional orphan cleanup)",
      responses: {
        200: {
          description:
            "Per-item results (id, created, changed) and the orphan-cleanup count",
        },
      },
    }),
    validateScope("knowledge:write"),
    validator(
      "json",
      v.object({
        items: v.pipe(
          v.array(
            v.object({
              sourceIdentifier: v.pipe(v.string(), v.minLength(1)),
              title: v.pipe(v.string(), v.minLength(1)),
              text: v.string(),
              parentId: v.optional(v.string()),
              teamId: v.optional(v.string()),
              tenantWide: v.optional(v.boolean()),
              embeddingEnabled: v.optional(v.boolean()),
              meta: v.optional(v.record(v.string(), v.unknown())),
            })
          ),
          v.maxLength(200)
        ),
        matchScope: v.optional(v.record(v.string(), v.string())),
        deleteOrphans: v.optional(v.boolean()),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const userId = c.get("usersId");
        const { items, matchScope, deleteOrphans } = c.req.valid("json");

        const results = [];
        for (const item of items) {
          results.push(
            await upsertKnowledgeTextFromSource({
              ...item,
              tenantId,
              userId,
              matchScope,
            })
          );
        }

        let orphansDeleted = 0;
        if (deleteOrphans) {
          const cleanup = await deleteOrphanedKnowledgeTexts({
            tenantId,
            activeSourceIdentifiers: items.map((i) => i.sourceIdentifier),
            matchScope,
          });
          orphansDeleted = cleanup.deleted;
        }

        return c.json({ results, orphansDeleted });
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Hybrid search over wiki pages (full-text + semantic, RRF-fused).
   * IMPORTANT: hono matches routes in registration order, so this static
   * "/search" route MUST be registered before GET /texts/:id — otherwise
   * ":id" swallows the request.
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/search",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Search knowledge text pages: hybrid full-text + semantic search with Reciprocal Rank Fusion (mode=hybrid|fulltext|semantic)",
      responses: {
        200: {
          description:
            "Ranked results with id, title, score, snippet and matchedBy legs",
        },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "query",
      v.object({
        q: v.pipe(v.string(), v.minLength(1)),
        mode: v.optional(v.picklist(["hybrid", "fulltext", "semantic"])),
        limit: v.optional(v.string()),
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        includeHidden: v.optional(v.string()),
        // facet + scope filters
        pageType: v.optional(v.string()),
        status: v.optional(v.string()),
        parentId: v.optional(v.string()),
        // JSON object of attribute equality filters (AND-combined)
        attributes: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const {
          q,
          mode,
          limit: limitStr,
          teamId,
          workspaceId,
          includeHidden: includeHiddenStr,
          pageType,
          status,
          parentId,
          attributes: attributesStr,
        } = c.req.valid("query");
        const { tenantId } = c.req.valid("param");
        const userId = c.get("usersId");

        const r = await searchKnowledgeTexts(
          q,
          {
            tenantId,
            userId,
            teamId,
            workspaceId,
            includeHidden: includeHiddenStr === "true",
          },
          {
            mode,
            limit: limitStr ? parseInt(limitStr) : undefined,
            filters: {
              pageType,
              status,
              parentId,
              attributes: parseAttributesFilter(attributesStr),
            },
          }
        );
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * heading outline of a page (structure without the body). Registered
   * before :id so the static path wins.
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/outline",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get a page's heading outline (structure without body text)",
      responses: { 200: { description: "Heading outline" } },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        return c.json(await getPageOutline(id, { tenantId, userId }));
      } catch (e) {
        const msg = e + "";
        if (msg.includes("not found") || msg.includes("access denied")) {
          throw new HTTPException(404, { message: msg });
        }
        throw new HTTPException(400, { message: msg });
      }
    }
  );

  /**
   * read a single section of a page addressed by its heading anchor.
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/section",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Read one section of a page addressed by its heading anchor",
      responses: { 200: { description: "The requested section" } },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    validator("query", v.object({ anchor: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const { anchor } = c.req.valid("query");
        const userId = c.get("usersId");
        const section = await readPageSection(id, anchor, { tenantId, userId });
        if (section.notFound) {
          throw new HTTPException(404, {
            message: `Section "${anchor}" not found`,
          });
        }
        return c.json(section);
      } catch (e) {
        if (e instanceof HTTPException) throw e;
        const msg = e + "";
        if (msg.includes("not found") || msg.includes("access denied")) {
          throw new HTTPException(404, { message: msg });
        }
        throw new HTTPException(400, { message: msg });
      }
    }
  );

  /**
   * Knowledge overview — the briefing an agent loads at session start: metrics,
   * top-level structure with summaries/facets, recent changes, and the embedded
   * agent-instructions page.
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/overview",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Get the knowledge overview (metrics, top-level, recent, instructions)",
      responses: { 200: { description: "Knowledge overview" } },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string() })),
    validator("query", v.object({ recentLimit: v.optional(v.string()) })),
    isTenantMember,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      const { recentLimit } = c.req.valid("query");
      const userId = c.get("usersId");
      const overview = await getKnowledgeOverview(
        { tenantId, userId },
        { recentLimit: recentLimit ? parseInt(recentLimit) : undefined }
      );
      return c.json(overview);
    }
  );

  /**
   * Resolve a page by exact title (case-insensitive, page link semantics).
   * Returns the page reference (without text) or 404.
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/resolve",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Resolve a knowledge page by its exact title",
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
   * Recent changes — visible pages newest-first, without text, filterable by
   * time window, subtree (parentId) and facets. Each item carries
   * summary + facets + updatedAt + updatedBy.
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/recent-changes",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "List recently changed knowledge pages",
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
        // JSON object of attribute equality filters (AND-combined)
        attributes: v.optional(v.string()),
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
          attributes: parseAttributesFilter(q.attributes),
          limit: q.limit ? parseInt(q.limit) : undefined,
        }
      );
      return c.json(r);
    }
  );

  /**
   * Batch-read several pages in one call. Body: { ids, includeText? }.
   * Pages the caller cannot see are silently dropped.
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/batch",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Read several knowledge pages by id in one request",
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

  /**
   * Get the tenant's knowledge config (facet vocabularies + auto-summary switch).
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/config",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get the tenant knowledge configuration (facet vocabularies, flags)",
      responses: { 200: { description: "Knowledge configuration" } },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      return c.json(await getKnowledgeTenantConfig(tenantId));
    }
  );

  /**
   * Update the tenant's knowledge config. Admin only (it changes the controlled
   * vocabulary and the cost/privacy-relevant auto-summary switch).
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/config",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Update the tenant knowledge configuration",
      responses: { 200: { description: "Updated knowledge configuration" } },
    }),
    validateScope("knowledge:write"),
    validator("param", v.object({ tenantId: v.string() })),
    validator(
      "json",
      v.object({
        autoSummaries: v.optional(v.boolean()),
        pageTypes: v.optional(v.array(v.string())),
        statuses: v.optional(v.array(v.string())),
        attributes: v.optional(
          v.array(
            v.object({
              key: v.pipe(v.string(), v.minLength(1)),
              label: v.optional(v.string()),
              values: v.optional(v.array(v.string())),
            })
          )
        ),
      })
    ),
    isTenantAdmin,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      const patch = c.req.valid("json");
      return c.json(await setKnowledgeTenantConfig(tenantId, patch));
    }
  );

  /**
   * Attribute discovery: the tenant's attribute definitions plus the values
   * actually in use on pages visible to the caller. Lets a UI or agent build
   * filter options (e.g. attributes={"hersteller":"Miele"}) without guessing.
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/attributes",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "List attribute definitions and the values in use",
      responses: {
        200: {
          description:
            "Attribute definitions (tenant config) and used values per key",
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string() })),
    validator(
      "query",
      v.object({
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
      })
    ),
    isTenantMember,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      const { teamId, workspaceId } = c.req.valid("query");
      const userId = c.get("usersId");
      const [config, used] = await Promise.all([
        getKnowledgeTenantConfig(tenantId),
        getUsedAttributeValues({ tenantId, userId, teamId, workspaceId }),
      ]);
      return c.json({ definitions: config.attributes, used });
    }
  );

  /**
   * Trigger a summary backfill — flag existing summary-less auto pages so the
   * debounced sweeper generates them. Admin only. Returns the number flagged.
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/summaries/backfill",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
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
      return c.json(await enqueueSummaryBackfill(tenantId));
    }
  );

  /**
   * Get single knowledge text entry by ID with full content
   * Returns latest version by default, or specific version with versionId query param
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Get single knowledge text entry with full content (latest version or specific versionId)",
      responses: {
        200: {
          description: "Successful response with full text content",
          content: {
            "application/json": {
              schema: resolver(knowledgeEntrySchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "query",
      v.object({
        versionId: v.optional(v.string()),
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        includeHidden: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const {
          versionId,
          teamId,
          workspaceId,
          includeHidden: includeHiddenStr,
        } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";

        const r = await getKnowledgeTextById(id, {
          tenantId,
          userId,
          teamId,
          workspaceId,
          includeHidden,
        });
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Get the version history for a knowledge text entry (newest first).
   * Each entry is a full snapshot of a previous version, including its
   * change authorship. Supports limit/page pagination.
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/history",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Get the version history for a knowledge text entry (newest first, paginated with limit/page)",
      responses: {
        200: {
          description:
            "Successful response with version snapshots (newest first), including change authorship",
          content: {
            "application/json": {
              schema: resolver(v.array(knowledgeEntrySchema)),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "query",
      v.object({
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        includeHidden: v.optional(v.string()),
        limit: v.optional(v.string()),
        page: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const {
          teamId,
          workspaceId,
          includeHidden: includeHiddenStr,
          limit: limitStr,
          page: pageStr,
        } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";
        const limit = limitStr ? parseInt(limitStr) : undefined;
        const page = pageStr ? parseInt(pageStr) : undefined;

        const r = await getKnowledgeTextHistory(
          id,
          {
            tenantId,
            userId,
            teamId,
            workspaceId,
            includeHidden,
          },
          { limit, page }
        );
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Get a single history version of a knowledge text entry by history id,
   * with full content (text + block snapshot).
   */
  app.get(
    API_BASE_PATH +
      "/tenant/:tenantId/knowledge/texts/:id/history/:historyId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Get a single history version of a knowledge text entry by history id (full content)",
      responses: {
        200: {
          description:
            "Successful response with the requested version snapshot",
          content: {
            "application/json": {
              schema: resolver(knowledgeEntrySchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "query",
      v.object({
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        includeHidden: v.optional(v.string()),
      })
    ),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        id: v.string(),
        historyId: v.string(),
      })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId, includeHidden: includeHiddenStr } =
          c.req.valid("query");
        const { tenantId, id, historyId } = c.req.valid("param");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";

        const r = await getKnowledgeTextHistoryVersion(id, historyId, {
          tenantId,
          userId,
          teamId,
          workspaceId,
          includeHidden,
        });
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (
          errorMsg.includes("not found") ||
          errorMsg.includes("access denied")
        ) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Update a knowledge text entry
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Update a knowledge text entry",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(knowledgeEntrySchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("json", knowledgeTextUpdateSchema),
    validator(
      "query",
      v.object({
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        includeHidden: v.optional(v.string()),
      })
    ),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId, includeHidden: includeHiddenStr } =
          c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const body = c.req.valid("json");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";
        validateOrganisationId(body, tenantId);

        const r = await updateKnowledgeText(id, body, {
          tenantId,
          userId,
          teamId,
          workspaceId,
          includeHidden,
        });
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Delete a knowledge text entry
   */
  app.delete(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Delete a knowledge text entry",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge:write"),
    validator(
      "query",
      v.object({
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        includeHidden: v.optional(v.string()),
      })
    ),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId, includeHidden: includeHiddenStr } =
          c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";

        await deleteKnowledgeText(id, {
          tenantId,
          userId,
          teamId,
          workspaceId,
          includeHidden,
        });
        return c.json(RESPONSES.SUCCESS);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Read a page's content like a file: optional line range with metadata
   * so agents can page through long documents
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/content",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Read a page's text content, optionally a line range (fromLine/maxLines), with line metadata",
      responses: {
        200: {
          description:
            "Content slice with fromLine, toLine and totalLines metadata",
        },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "query",
      v.object({
        fromLine: v.optional(v.string()),
        maxLines: v.optional(v.string()),
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        includeHidden: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const {
          fromLine: fromLineStr,
          maxLines: maxLinesStr,
          teamId,
          workspaceId,
          includeHidden: includeHiddenStr,
        } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        const r = await readKnowledgeTextContent(
          id,
          {
            tenantId,
            userId,
            teamId,
            workspaceId,
            includeHidden: includeHiddenStr === "true",
          },
          {
            fromLine: fromLineStr ? parseInt(fromLineStr) : undefined,
            maxLines: maxLinesStr ? parseInt(maxLinesStr) : undefined,
          }
        );
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Edit a page's content like a file: exact string replacement.
   * Works on plain text pages and inside the blocks of block pages.
   */
  app.patch(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/content",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Edit a page via exact string replacement (oldString/newString, optional replaceAll)",
      responses: {
        200: {
          description:
            "Successful response with replacement count and the new content",
        },
      },
    }),
    validateScope("knowledge:write"),
    validator(
      "json",
      v.object({
        oldString: v.pipe(v.string(), v.minLength(1)),
        newString: v.string(),
        replaceAll: v.optional(v.boolean()),
      })
    ),
    validator("query", contextQuerySchema),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId, includeHidden: includeHiddenStr } =
          c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const { oldString, newString, replaceAll } = c.req.valid("json");
        const userId = c.get("usersId");

        const r = await editKnowledgeTextContent(
          id,
          { oldString, newString, replaceAll },
          {
            tenantId,
            userId,
            teamId,
            workspaceId,
            includeHidden: includeHiddenStr === "true",
          }
        );
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found in the document")) {
          // edit conflicts are client errors with actionable messages
          throw new HTTPException(409, { message: errorMsg });
        }
        if (errorMsg.includes("not unique") || errorMsg.includes("spans multiple blocks")) {
          throw new HTTPException(409, { message: errorMsg });
        }
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * append text to a page without a read-modify-write round trip and
   * without returning the full content. Goes through the normal edit path
   * (history, permissions, bookkeeping, summary-stale marking).
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/append",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Append text to a knowledge page (no full content in response)",
      responses: {
        200: {
          description: "Append result (id, appendedChars, totalChars)",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  id: v.string(),
                  appendedChars: v.number(),
                  totalChars: v.number(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("knowledge:write"),
    validator(
      "json",
      v.object({
        text: v.string(),
        separator: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { text, separator } = c.req.valid("json");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const r = await appendToKnowledgeText(
          id,
          text,
          { tenantId, userId },
          { separator }
        );
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (
          errorMsg.includes("not found") ||
          errorMsg.includes("access denied")
        ) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Upload an image for a wiki page (block editor image upload).
   * Returns the file id, the auth-protected path and a ready-to-insert
   * markdown snippet. The upload expires automatically unless a following
   * page save references it; removing the image from the content later
   * schedules it for cleanup again.
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/images",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Upload an image for a wiki page; returns a markdown snippet to embed",
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: v.object({
              file: v.any(),
              alt: v.optional(v.string()),
            }),
          },
        },
      },
      responses: {
        200: {
          description:
            "Successful response with fileId, path and markdown snippet",
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const form = await c.req.formData();

        const file = form.get("file");
        if (!(file instanceof File)) {
          throw new Error("Missing 'file' form field");
        }

        const r = await uploadKnowledgeTextImage(
          id,
          file,
          { tenantId, userId },
          { alt: form.get("alt")?.toString() || undefined }
        );
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Outgoing page links of a page ([[Title]] markers in its content)
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/links",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Get the outgoing page links of a page (resolved and phantom links)",
      responses: {
        200: { description: "List of outgoing links" },
      },
    }),
    validateScope("knowledge:read"),
    validator("query", contextQuerySchema),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId, includeHidden: includeHiddenStr } =
          c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        const r = await getKnowledgeTextLinks(id, {
          tenantId,
          userId,
          teamId,
          workspaceId,
          includeHidden: includeHiddenStr === "true",
        });
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Backlinks: every visible page that links to this page
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/backlinks",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get all pages that link to this page (backlinks)",
      responses: {
        200: { description: "List of linking pages" },
      },
    }),
    validateScope("knowledge:read"),
    validator("query", contextQuerySchema),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId, includeHidden: includeHiddenStr } =
          c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        const r = await getKnowledgeTextBacklinks(id, {
          tenantId,
          userId,
          teamId,
          workspaceId,
          includeHidden: includeHiddenStr === "true",
        });
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Semantically related pages via stored chunk embeddings
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/related",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Get semantically related pages (embedding similarity; requires embedding-enabled pages)",
      responses: {
        200: { description: "List of related pages ordered by similarity" },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "query",
      v.object({
        limit: v.optional(v.string()),
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        includeHidden: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const {
          limit: limitStr,
          teamId,
          workspaceId,
          includeHidden: includeHiddenStr,
        } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        const r = await getRelatedKnowledgeTexts(
          id,
          {
            tenantId,
            userId,
            teamId,
            workspaceId,
            includeHidden: includeHiddenStr === "true",
          },
          { limit: limitStr ? parseInt(limitStr) : undefined }
        );
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Chunk context window: the addressed chunk + neighbours (before/after by order).
   * Only meaningful for embedding-enabled pages (otherwise chunks: []).
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/chunk-context",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Get a matched chunk plus its neighbouring chunks (before/after by order) for an embedding-enabled page",
      responses: {
        200: { description: "Chunk context window (chunks ordered by order)" },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "query",
      v.object({
        order: v.optional(v.string()),
        before: v.optional(v.string()),
        after: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { order, before, after } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const r = await getPageChunkContext(
          id,
          { tenantId, userId },
          {
            order: order ? parseInt(order) : undefined,
            before: before ? parseInt(before) : undefined,
            after: after ? parseInt(after) : undefined,
          }
        );
        return c.json(r);
      } catch (e) {
        const msg = e + "";
        if (msg.includes("not found") || msg.includes("access denied")) {
          throw new HTTPException(404, { message: msg });
        }
        throw new HTTPException(400, { message: msg });
      }
    }
  );

  /**
   * Get a page in a simplified, LLM-friendly shape: { id, title, content }.
   * `content` is the full page text with all blocks already merged.
   * With ?recursive=true the whole subtree is nested under `children`.
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/simplified",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Get a knowledge text page as simplified JSON (id, title, content); ?recursive=true nests all sub-pages under children",
      responses: {
        200: {
          description: "Successful response with the simplified page",
          content: {
            "application/json": {
              schema: resolver(simplifiedKnowledgeTextSchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "query",
      v.object({
        recursive: v.optional(v.string()),
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        includeHidden: v.optional(v.string()),
        // subtree limits — cap depth and total characters. Truncations are
        // flagged explicitly (contentTruncated / childrenOmitted), never silent.
        maxDepth: v.optional(v.string()),
        maxChars: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const {
          recursive: recursiveStr,
          teamId,
          workspaceId,
          includeHidden: includeHiddenStr,
          maxDepth: maxDepthStr,
          maxChars: maxCharsStr,
        } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";
        const recursive = recursiveStr === "true";
        const maxDepth = maxDepthStr ? parseInt(maxDepthStr) : undefined;
        const maxChars = maxCharsStr ? parseInt(maxCharsStr) : undefined;

        const r = await getSimplifiedKnowledgeText(
          id,
          { tenantId, userId, teamId, workspaceId, includeHidden },
          { recursive, maxDepth, maxChars }
        );
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Get all blocks of a knowledge text page in display order
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/blocks",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get all content blocks of a knowledge text page in order",
      responses: {
        200: {
          description: "Successful response with the ordered block list",
          content: {
            "application/json": {
              schema: resolver(v.array(knowledgeTextBlockSchema)),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("query", contextQuerySchema),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId, includeHidden: includeHiddenStr } =
          c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";

        const r = await getKnowledgeTextBlocks(id, {
          tenantId,
          userId,
          teamId,
          workspaceId,
          includeHidden,
        });
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Batch-save the full block list of a knowledge text page.
   * The block editor sends its complete document state; the server diffs
   * by block id (insert/update/delete), re-materializes the text cache,
   * snapshots history (coalesced) and re-syncs the embedding if enabled.
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/blocks",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Batch-save the full block list of a knowledge text page",
      responses: {
        200: {
          description:
            "Successful response with the updated page and its blocks",
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("json", syncBlocksBodySchema),
    validator("query", contextQuerySchema),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId, includeHidden: includeHiddenStr } =
          c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const { blocks } = c.req.valid("json");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";

        const r = await syncKnowledgeTextBlocks(id, blocks, {
          tenantId,
          userId,
          teamId,
          workspaceId,
          includeHidden,
        });
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );

  /**
   * Convert a legacy plain-text page into block mode
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/convert-to-blocks",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Convert a plain-text knowledge text page into block mode (no-op if already blocks)",
      responses: {
        200: {
          description:
            "Successful response with the converted page and its blocks",
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("query", contextQuerySchema),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId, includeHidden: includeHiddenStr } =
          c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";

        const r = await convertKnowledgeTextToBlocks(id, {
          tenantId,
          userId,
          teamId,
          workspaceId,
          includeHidden,
        });
        return c.json(r);
      } catch (e) {
        const errorMsg = e + "";
        if (errorMsg.includes("not found") || errorMsg.includes("access denied")) {
          throw new HTTPException(404, { message: errorMsg });
        }
        throw new HTTPException(400, { message: errorMsg });
      }
    }
  );
}
