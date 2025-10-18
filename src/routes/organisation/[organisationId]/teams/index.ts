/**
 * Routes to manage the teams of an organisation
 * These routes are protected by JWT and CheckPermission middleware
 */

import type { FastAppHono } from "../../../../types";
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
 * Middleware to check if user is a member of the organisation
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
  app: FastAppHono,
  API_BASE_PATH: string
) {
  /**
   * Create a new team
   */
  app.post(
    API_BASE_PATH + "/organisation/:organisationId/teams",
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
    validator("param", v.object({ organisationId: v.string() })),
    async (c) => {
      try {
        const data = c.req.valid("json");
        const userId = c.get("usersId");
        const { organisationId } = c.req.valid("param");
        const team = await createTeam(data);
        // assign the user to the team
        await addTeamMember(team.id, organisationId, userId, "admin");

        return c.json(team);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error creating team: " + err,
        });
      }
    }
  );

  /**
   * Get all teams of an organisation
   */
  app.get(
    API_BASE_PATH + "/organisation/:organisationId/teams",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary: "Get all teams of an organisation",
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
    validator("param", v.object({ organisationId: v.string() })),
    async (c) => {
      try {
        const { organisationId } = c.req.valid("param");
        const teams = await getTeamsByUser(c.get("usersId"), organisationId);
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
    API_BASE_PATH + "/organisation/:organisationId/teams/:teamId",
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
      v.object({ organisationId: v.string(), teamId: v.string() })
    ),
    isTeamMember, // check if user is a member of the organisation
    async (c) => {
      const { organisationId, teamId } = c.req.valid("param");
      const team = await getTeam(teamId);
      return c.json(team);
    }
  );

  /**
   * Update a team
   */
  app.put(
    API_BASE_PATH + "/organisation/:organisationId/teams/:teamId",
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
      v.object({ organisationId: v.string(), teamId: v.string() })
    ),
    isTeamAdmin, // check if user is an admin of the team
    async (c) => {
      try {
        const { organisationId, teamId } = c.req.valid("param");
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
    API_BASE_PATH + "/organisation/:organisationId/teams/:teamId",
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
      v.object({ organisationId: v.string(), teamId: v.string() })
    ),
    isTeamAdmin, // check if user is an admin of the team
    async (c) => {
      try {
        const { organisationId, teamId } = c.req.valid("param");
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
    API_BASE_PATH + "/organisation/:organisationId/teams/:teamId/members",
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
      v.object({ organisationId: v.string(), teamId: v.string() })
    ),
    isTeamMember, // check if user is a member of the team
    async (c) => {
      try {
        const { organisationId, teamId } = c.req.valid("param");
        const members = await getTeamMembers(
          c.get("usersId"),
          organisationId,
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
    API_BASE_PATH + "/organisation/:organisationId/teams/:teamId/members",
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
      })
    ),
    validator(
      "param",
      v.object({ organisationId: v.string(), teamId: v.string() })
    ),
    isTeamAdmin, // check if user is an admin of the team
    async (c) => {
      try {
        const { userId, role } = await c.req.valid("json");
        const { organisationId, teamId } = c.req.valid("param");
        const member = await addTeamMember(
          teamId,
          organisationId,
          userId,
          role
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
      "/organisation/:organisationId/teams/:teamId/members/:destinationUserId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["teams"],
      summary: "Change the role of a member",
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
        role: v.union([v.literal("admin"), v.literal("member")]),
      })
    ),
    validator(
      "param",
      v.object({
        organisationId: v.string(),
        teamId: v.string(),
        destinationUserId: v.string(),
      })
    ),
    isTeamAdmin, // check if user is an admin of the team
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { role } = c.req.valid("json");
        const { organisationId, teamId, destinationUserId } =
          c.req.valid("param");

        const member = await updateTeamMemberRole(
          teamId,
          destinationUserId,
          role
        );
        return c.json(member);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error updating team member role: " + err,
        });
      }
    }
  );

  /**
   * Remove a member from a team
   */
  app.delete(
    API_BASE_PATH +
      "/organisation/:organisationId/teams/:teamId/members/:destinationUserId",
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
        organisationId: v.string(),
        teamId: v.string(),
        destinationUserId: v.string(),
      })
    ),
    isTeamAdmin, // check if user is an admin of the team
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { organisationId, teamId, destinationUserId } =
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
