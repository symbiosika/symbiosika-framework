/**
 * Routes to manage the teams of an tenant
 * These routes are protected by JWT and CheckPermission middleware
 */

import type { SymbiosikaFrameworkHonoApp } from "../../../../types";
import { HTTPException } from "hono/http-exception";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../lib/utils/hono-middlewares";
import {
  createTeam,
  getTeam,
  updateTeam,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  updateTeamMemberRole,
  updateTeamMemberKnowledgeAccess,
  checkTeamMemberRole,
  getTeamsByUser,
  getTeamMembers,
} from "../../../../lib/usermanagement/teams";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { RESPONSES } from "../../../../lib/responses";
import type { MiddlewareHandler } from "hono";
import { validateScope } from "../../../../lib/utils/validate-scope";
import {
  teamsSelectSchema,
  teamsInsertSchema,
} from "../../../../lib/db/db-schema";

/**
 * Middleware to check if user is a member of the tenant
 */
export const isTeamMember: MiddlewareHandler = async (c, next) => {
  const userId = c.get("usersId");
  const teamId = c.req.param("teamId")!;

  try {
    await checkTeamMemberRole(teamId, userId, ["admin", "member"]);
    await next();
  } catch (err) {
    throw new HTTPException(403, {
      message: "User is not a member of this team",
    });
  }
};

/**
 * Middleware to check if user is an admin of the team
 */
export const isTeamAdmin: MiddlewareHandler = async (c, next) => {
  const userId = c.get("usersId");
  const teamId = c.req.param("teamId")!;

  try {
    await checkTeamMemberRole(teamId, userId, ["admin"]);
    await next();
  } catch (err) {
    throw new HTTPException(403, {
      message: "User is not an admin of this team",
    });
  }
};

/**
 * Middleware to check if the user is Admin of the Team with the given teamId in the Body of the request
 */
export const isTeamAdminForPayload: MiddlewareHandler = async (c, next) => {
  const userId = c.get("usersId");
  const teamId = (await c.req.json())?.teamId;
  if (!teamId || teamId == null || teamId === "") {
    return await next();
  }
  await checkTeamMemberRole(teamId, userId, ["admin"]);
  await next();
};

/**
 * Middleware to check if the user is at least member of the Team with the given teamId in the Body of the request
 */
export const isTeamMemberForPayload: MiddlewareHandler = async (c, next) => {
  const userId = c.get("usersId");
  const teamId = (await c.req.json())?.teamId;
  if (!teamId || teamId == null || teamId === "") {
    return await next();
  }
  await checkTeamMemberRole(teamId, userId, ["admin", "member"]);
  await next();
};

export default function defineTeamRoutes(
  app: SymbiosikaFrameworkHonoApp,
  API_BASE_PATH: string
) {
  /**
   * Create a new team
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/teams",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary: "Create a new team",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(teamsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("teams:write"),
    validator("json", teamsInsertSchema),
    validator("param", v.object({ tenantId: v.string() })),
    async (c) => {
      try {
        const data = c.req.valid("json");
        const userId = c.get("usersId");
        const { tenantId } = c.req.valid("param");
        const team = await createTeam(data);
        // assign the user to the team
        await addTeamMember(team.id, tenantId, userId, "admin");

        return c.json(team);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error creating team: " + err,
        });
      }
    }
  );

  /**
   * Get all teams of an tenant
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/teams",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary: "Get all teams of an tenant",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(v.array(teamsSelectSchema)),
            },
          },
        },
      },
    }),
    validateScope("teams:read"),
    validator("param", v.object({ tenantId: v.string() })),
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const teams = await getTeamsByUser(c.get("usersId"), tenantId);
        return c.json(teams);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting teams: " + err,
        });
      }
    }
  );

  /**
   * Get a team by teamId
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/teams/:teamId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary: "Get a team by its id",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(teamsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("teams:read"),
    validator(
      "param",
      v.object({ tenantId: v.string(), teamId: v.string() })
    ),
    isTeamMember, // check if user is a member of the tenant
    async (c) => {
      const { tenantId, teamId } = c.req.valid("param");
      const team = await getTeam(teamId);
      return c.json(team);
    }
  );

  /**
   * Update a team
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/teams/:teamId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary: "Update a team",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(teamsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("teams:write"),
    validator("json", teamsInsertSchema),
    validator(
      "param",
      v.object({ tenantId: v.string(), teamId: v.string() })
    ),
    isTeamAdmin, // check if user is an admin of the team
    async (c) => {
      try {
        const { tenantId, teamId } = c.req.valid("param");
        const data = c.req.valid("json");
        const team = await updateTeam(teamId, data);
        return c.json(team);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error updating team: " + err,
        });
      }
    }
  );

  /**
   * Delete a team
   */
  app.delete(
    API_BASE_PATH + "/tenant/:tenantId/teams/:teamId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary: "Delete a team",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("teams:write"),
    validator(
      "param",
      v.object({ tenantId: v.string(), teamId: v.string() })
    ),
    isTeamAdmin, // check if user is an admin of the team
    async (c) => {
      try {
        const { tenantId, teamId } = c.req.valid("param");
        await deleteTeam(teamId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error deleting team: " + err,
        });
      }
    }
  );

  /**
   * Get all members of a team
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/teams/:teamId/members",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary: "Get all members of a team",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    teamId: v.string(),
                    userId: v.string(),
                    userEmail: v.string(),
                    role: v.union([v.literal("admin"), v.literal("member")]),
                    knowledgeAccess: v.union([
                      v.literal("read"),
                      v.literal("write"),
                    ]),
                  })
                )
              ),
            },
          },
        },
      },
    }),
    validateScope("teams:read"),
    validator(
      "param",
      v.object({ tenantId: v.string(), teamId: v.string() })
    ),
    isTeamMember, // check if user is a member of the team
    async (c) => {
      try {
        const { tenantId, teamId } = c.req.valid("param");
        const members = await getTeamMembers(
          c.get("usersId"),
          tenantId,
          teamId
        );
        return c.json(members);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting team members: " + err,
        });
      }
    }
  );

  /**
   * Add a member to a team
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/teams/:teamId/members",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary: "Add a member to a team",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  userId: v.string(),
                  teamId: v.string(),
                  role: v.union([v.literal("admin"), v.literal("member")]),
                  knowledgeAccess: v.union([
                    v.literal("read"),
                    v.literal("write"),
                  ]),
                  joinedAt: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("teams:write"),
    validator(
      "json",
      v.object({
        userId: v.string(),
        role: v.union([v.literal("admin"), v.literal("member")]),
        // read/write access to this team's knowledge; defaults to "write"
        knowledgeAccess: v.optional(
          v.union([v.literal("read"), v.literal("write")])
        ),
      })
    ),
    validator(
      "param",
      v.object({ tenantId: v.string(), teamId: v.string() })
    ),
    isTeamAdmin, // check if user is an admin of the team
    async (c) => {
      try {
        const { userId, role, knowledgeAccess } = await c.req.valid("json");
        const { tenantId, teamId } = c.req.valid("param");
        const member = await addTeamMember(
          teamId,
          tenantId,
          userId,
          role,
          knowledgeAccess
        );
        return c.json(member);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error adding team member: " + err,
        });
      }
    }
  );

  /**
   * Change the role of a member
   */
  app.put(
    API_BASE_PATH +
      "/tenant/:tenantId/teams/:teamId/members/:destinationUserId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary:
        "Change the role and/or knowledge access level of a team member",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  userId: v.string(),
                  teamId: v.string(),
                  role: v.union([v.literal("admin"), v.literal("member")]),
                  knowledgeAccess: v.union([
                    v.literal("read"),
                    v.literal("write"),
                  ]),
                  joinedAt: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("teams:write"),
    validator(
      "json",
      v.object({
        role: v.optional(v.union([v.literal("admin"), v.literal("member")])),
        // read/write access to this team's knowledge ("read" | "write")
        knowledgeAccess: v.optional(
          v.union([v.literal("read"), v.literal("write")])
        ),
      })
    ),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        teamId: v.string(),
        destinationUserId: v.string(),
      })
    ),
    isTeamAdmin, // check if user is an admin of the team
    async (c) => {
      try {
        const { role, knowledgeAccess } = c.req.valid("json");
        const { tenantId, teamId, destinationUserId } =
          c.req.valid("param");

        if (role === undefined && knowledgeAccess === undefined) {
          throw new HTTPException(400, {
            message: "Provide 'role' and/or 'knowledgeAccess' to update",
          });
        }

        let member;
        if (role !== undefined) {
          member = await updateTeamMemberRole(
            teamId,
            destinationUserId,
            role
          );
        }
        if (knowledgeAccess !== undefined) {
          member = await updateTeamMemberKnowledgeAccess(
            teamId,
            destinationUserId,
            knowledgeAccess
          );
        }
        return c.json(member);
      } catch (err) {
        if (err instanceof HTTPException) throw err;
        throw new HTTPException(500, {
          message: "Error updating team member: " + err,
        });
      }
    }
  );

  /**
   * Remove a member from a team
   */
  app.delete(
    API_BASE_PATH +
      "/tenant/:tenantId/teams/:teamId/members/:destinationUserId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary: "Remove a member from a team",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("teams:write"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        teamId: v.string(),
        destinationUserId: v.string(),
      })
    ),
    isTeamAdmin, // check if user is an admin of the team
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { tenantId, teamId, destinationUserId } =
          c.req.valid("param");

        await removeTeamMember(teamId, destinationUserId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error removing team member: " + err,
        });
      }
    }
  );
}
