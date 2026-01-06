/**
 * Routes to manage the knowledge entries for each tenant
 * These routes are protected by JWT and CheckPermission middleware
 */
import type { FastAppHono } from "../../../../../types";
import * as v from "valibot";
import { HTTPException } from "hono/http-exception";
import { RESPONSES } from "../../../../../lib/responses";
import {
  createKnowledgeText,
  getKnowledgeText,
  getKnowledgeTextHistory,
  updateKnowledgeText,
  deleteKnowledgeText,
} from "../../../../../lib/knowledge/knowledge-texts";
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
} from "../../../../../lib/db/db-schema";
import { isTenantMember } from "../../..";
import { validateScope } from "../../../../../lib/utils/validate-scope";

export default function defineRoutesForKnowledgeTexts(
  app: FastAppHono,
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
   * Read knowledge text entries (returns only latest versions)
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Read knowledge text entries (returns only latest versions)",
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
        id: v.optional(v.string()),
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        limit: v.optional(v.string()),
        page: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const {
          id,
          teamId,
          workspaceId,
          limit: limitStr,
          page: pageStr,
        } = c.req.valid("query");
        const { tenantId } = c.req.valid("param");
        const userId = c.get("usersId");
        const limit = limitStr ? parseInt(limitStr) : undefined;
        const page = pageStr ? parseInt(pageStr) : undefined;

        const r = await getKnowledgeText({
          id,
          limit,
          page,
          tenantId,
          userId,
          teamId,
          workspaceId,
        });
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Get complete version history for a knowledge text entry
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/texts/:id/history",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get complete version history for a knowledge text entry",
      responses: {
        200: {
          description: "Successful response with all versions chronologically",
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
      })
    ),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        const r = await getKnowledgeTextHistory(id, {
          tenantId,
          userId,
          teamId,
          workspaceId,
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
      })
    ),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const body = c.req.valid("json");
        const userId = c.get("usersId");
        validateOrganisationId(body, tenantId);

        const r = await updateKnowledgeText(id, body, {
          tenantId,
          userId,
          teamId,
          workspaceId,
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
      })
    ),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, workspaceId } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        await deleteKnowledgeText(id, {
          tenantId,
          userId,
          teamId,
          workspaceId,
        });
        return c.json(RESPONSES.SUCCESS);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );
}
