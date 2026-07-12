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
} from "../../../../../lib/db/db-schema";
import { isTenantMember } from "../../..";
import { validateScope } from "../../../../../lib/utils/validate-scope";

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

        const r = await createKnowledgeText({
          ...body,
          userId: c.get("usersId"),
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
        });
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
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
   * Get complete version history for a knowledge text entry WITHOUT text content
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/history",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Get complete version history for a knowledge text entry WITHOUT text content",
      responses: {
        200: {
          description:
            "Successful response with all versions chronologically (metadata only)",
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
      })
    ),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId, includeHidden: includeHiddenStr } =
          c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";

        const r = await getKnowledgeTextHistory(id, {
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
        } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");
        const includeHidden = includeHiddenStr === "true";
        const recursive = recursiveStr === "true";

        const r = await getSimplifiedKnowledgeText(
          id,
          { tenantId, userId, teamId, workspaceId, includeHidden },
          { recursive }
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
