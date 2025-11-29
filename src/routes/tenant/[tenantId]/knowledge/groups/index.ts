/**
 * Routes to manage the knowledge entries for each tenant
 * These routes are protected by JWT and CheckPermission middleware
 */
import type { FastAppHono } from "../../../../../types";
import * as v from "valibot";
import { HTTPException } from "hono/http-exception";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../../lib/utils/hono-middlewares";
import { validateOrganisationId } from "../../../../../lib/utils/doublecheck-tenant";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";

import { isTenantAdmin, isTenantMember } from "../../..";

import {
  createKnowledgeGroup,
  getKnowledgeGroups,
  getKnowledgeGroupById,
  updateKnowledgeGroup,
  deleteKnowledgeGroup,
  assignTeamToKnowledgeGroup,
  removeTeamFromKnowledgeGroup,
  getTeamsForKnowledgeGroup,
} from "../../../../../lib/knowledge/knowledge-groups";
import { RESPONSES } from "../../../../../lib/responses";
import { validateScope } from "../../../../../lib/utils/validate-scope";

// Add validation schema for knowledge groups
const knowledgeGroupValidation = v.object({
  tenantId: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  tenantWideAccess: v.optional(v.boolean()),
});

const knowledgeGroupUpdateValidation = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  tenantWideAccess: v.optional(v.boolean()),
});

export default function defineKnowledgeGroupRoutes(
  app: FastAppHono,
  API_BASE_PATH: string
) {
  /**
   * Create a new knowledge group
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/groups",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Create a new knowledge group",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge-manage:write"),
    validator("json", knowledgeGroupValidation),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const body = c.req.valid("json");
        const { tenantId } = c.req.valid("param");
        const userId = c.get("usersId");
        validateOrganisationId(body, tenantId);

        const group = await createKnowledgeGroup({
          ...body,
          userId,
          tenantId,
        });
        return c.json(group);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Get all knowledge groups
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/groups",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get all knowledge groups",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge-manage:read"),
    validator(
      "query",
      v.object({
        teamId: v.optional(v.string()),
        includeTeamAssignments: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { teamId, includeTeamAssignments } = c.req.valid("query");
        const { tenantId } = c.req.valid("param");
        const userId = c.get("usersId");

        const groups = await getKnowledgeGroups({
          tenantId,
          userId,
          teamId,
          includeTeamAssignments: includeTeamAssignments === "true",
        });
        return c.json(groups);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Get a specific knowledge group by ID
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/groups/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get a specific knowledge group by ID",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge-manage:read"),
    validator(
      "query",
      v.object({
        includeTeamAssignments: v.optional(v.string()),
      })
    ),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { includeTeamAssignments } = c.req.valid("query");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        const group = await getKnowledgeGroupById(id, {
          tenantId,
          userId,
          includeTeamAssignments: includeTeamAssignments === "true",
        });

        if (!group) {
          throw new HTTPException(404, {
            message: "Knowledge group not found",
          });
        }

        return c.json(group);
      } catch (e) {
        if (e instanceof HTTPException) throw e;
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Update a knowledge group
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/groups/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Update a knowledge group",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge-manage:write"),
    validator("json", knowledgeGroupUpdateValidation),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    isTenantAdmin,
    async (c) => {
      try {
        const body = c.req.valid("json");
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        const updatedGroup = await updateKnowledgeGroup(id, body, {
          tenantId,
          userId,
        });
        return c.json(updatedGroup);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Delete a knowledge group
   */
  app.delete(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/groups/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Delete a knowledge group",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge-manage:write"),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        await deleteKnowledgeGroup(id, { tenantId, userId });
        return c.json(RESPONSES.SUCCESS);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Assign a team to a knowledge group
   */
  app.post(
    API_BASE_PATH +
      "/tenant/:tenantId/knowledge/groups/:id/teams/:teamId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Assign a team to a knowledge group",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge-manage:write"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        id: v.string(),
        teamId: v.string(),
      })
    ),
    isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id, teamId } = c.req.valid("param");
        const userId = c.get("usersId");

        await assignTeamToKnowledgeGroup(id, teamId, {
          tenantId,
          userId,
        });
        return c.json(RESPONSES.SUCCESS);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Remove a team from a knowledge group
   */
  app.delete(
    API_BASE_PATH +
      "/tenant/:tenantId/knowledge/groups/:id/teams/:teamId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Remove a team from a knowledge group",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge-manage:write"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        id: v.string(),
        teamId: v.string(),
      })
    ),
    isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id, teamId } = c.req.valid("param");
        const userId = c.get("usersId");

        await removeTeamFromKnowledgeGroup(id, teamId, {
          tenantId,
          userId,
        });
        return c.json(RESPONSES.SUCCESS);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Get teams assigned to a knowledge group
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/groups/:id/teams",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get teams assigned to a knowledge group",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    id: v.string(),
                    teamId: v.string(),
                    teamName: v.string(),
                  })
                )
              ),
            },
          },
        },
      },
    }),
    validateScope("knowledge-manage:read"),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        const teams = await getTeamsForKnowledgeGroup(id, {
          tenantId,
          userId,
        });
        return c.json(teams);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );
}
