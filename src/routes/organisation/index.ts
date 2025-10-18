/**
 * Routes to manage organisations
 * These routes are for the admin of the organisation and normally not used by a SPA or any Frontend
 */
import type { FastAppHono } from "../../types";
import { HTTPException } from "hono/http-exception";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../lib/utils/hono-middlewares";
import {
  createOrganisation,
  getOrganisation,
  updateOrganisation,
  deleteOrganisation,
  getOrganisationMembers,
  addOrganisationMember,
  dropUserFromOrganisation,
  getUserOrganisations,
  getOrganisationMemberRole,
  updateOrganisationMemberRole,
} from "../../lib/usermanagement/oganisations";
import { RESPONSES } from "../../lib/responses";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import {
  organisationInvitationsSelectSchema,
  organisationMembersSelectSchema,
  organisationsInsertSchema,
  organisationsSelectSchema,
  organisationsUpdateSchema,
} from "../../lib/db/db-schema";
import { createOrganisationInvitation } from "../../lib/usermanagement/invitations";
import type { MiddlewareHandler } from "hono";
import { validateScope } from "../../lib/utils/validate-scope";

/**
 * Middleware to check if user is a member of the organisation
 */
export const isOrganisationMember: MiddlewareHandler = async (c, next) => {
  const userId = c.get("usersId");
  const organisationId = c.req.param("organisationId")!;

  try {
    await getOrganisationMemberRole(organisationId, userId);
    await next();
  } catch (err) {
    throw new HTTPException(403, {
      message: "User is not a member of this organisation",
    });
  }
};

/**
 * Middleware to check if user is an admin or owner of the organisation
 */
export const isOrganisationAdmin: MiddlewareHandler = async (c, next) => {
  const userId = c.get("usersId");
  const organisationId = c.req.param("organisationId")!;

  try {
    const role = await getOrganisationMemberRole(organisationId, userId);
    if (role !== "admin" && role !== "owner") {
      throw new HTTPException(403, {
        message: "User is not an admin or owner of this organisation",
      });
    }
    await next();
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw new HTTPException(403, {
      message: "Error checking admin permissions: " + err,
    });
  }
};

/**
 * Helper to check that an key of an object is the same as the organisationId
 */
export const checkOrganisationIdInBody: MiddlewareHandler = async (c, next) => {
  const organisationId = c.req.param("organisationId");
  // @ts-ignore
  const json: { organisationId: string } = c.req.valid("json");

  if (
    !json.organisationId ||
    !organisationId ||
    json.organisationId !== organisationId
  ) {
    throw new HTTPException(403, {
      message:
        "The organisationId in the body does not match the organisationId in the path",
    });
  }
  await next();
};

export default function defineOrganisationRoutes(
  app: FastAppHono,
  API_BASE_PATH: string
) {
  /**
   * Create a new organisation
   */
  app.post(
    API_BASE_PATH + "/organisation",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Create a new organisation",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(organisationsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("organisations:write"),
    validator("json", organisationsInsertSchema),
    async (c) => {
      try {
        const data = c.req.valid("json");
        const userId = c.get("usersId");
        // check if the user has already an organisation
        const userOrganisations = await getUserOrganisations(userId);
        if (userOrganisations.length > 0) {
          throw new HTTPException(400, {
            message: "User already has an organisation",
          });
        }

        // create the organisation
        const org = await createOrganisation(data);
        // put the user in the organisation
        await addOrganisationMember(org.id, userId, "owner");
        return c.json(org);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error creating organisation: " + err,
        });
      }
    }
  );

  /**
   * Get an organisation
   */
  app.get(
    API_BASE_PATH + "/organisation/:organisationId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Get an organisation",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(organisationsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("organisations:read"),
    validator("param", v.object({ organisationId: v.string() })),
    isOrganisationMember,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { organisationId } = c.req.valid("param");
        const org = await getOrganisation(organisationId);
        return c.json(org);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting organisation: " + err,
        });
      }
    }
  );

  /**
   * Get all members of an organisation
   */
  app.get(
    API_BASE_PATH + "/organisation/:organisationId/members",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Get all members of an organisation",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    userEmail: v.string(),
                    role: v.union([
                      v.literal("admin"),
                      v.literal("member"),
                      v.literal("owner"),
                    ]),
                    joinedAt: v.string(),
                  })
                )
              ),
            },
          },
        },
      },
    }),
    validateScope("organisations:read"),
    validator("param", v.object({ organisationId: v.string() })),
    isOrganisationMember, // check if user is a member of the organisation
    async (c) => {
      const userId = c.get("usersId");
      const { organisationId } = c.req.valid("param");
      const members = await getOrganisationMembers(userId, organisationId);
      return c.json(members);
    }
  );

  /**
   * Update an organisation
   */
  app.put(
    API_BASE_PATH + "/organisation/:organisationId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Update an organisation",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(organisationsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("organisations:write"),
    validator("json", organisationsUpdateSchema),
    validator("param", v.object({ organisationId: v.string() })),
    isOrganisationAdmin, // check if user is admin or owner of the organisation
    async (c) => {
      try {
        const data = c.req.valid("json");
        const org = await updateOrganisation(
          c.req.valid("param").organisationId,
          data
        );
        return c.json(org);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error updating organisation: " + err,
        });
      }
    }
  );

  /**
   * Delete an organisation
   */
  app.delete(
    API_BASE_PATH + "/organisation/:organisationId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Delete an organisation",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    validateScope("organisations:write"),
    validator("param", v.object({ organisationId: v.string() })),
    isOrganisationAdmin, // check if user is admin or owner of the organisation
    async (c) => {
      try {
        const { organisationId } = c.req.valid("param");
        await deleteOrganisation(organisationId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error deleting organisation: " + err,
        });
      }
    }
  );

  /**
   * Invite a user to an organisation
   */
  app.post(
    API_BASE_PATH + "/organisation/:organisationId/invite",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Invite a user to an organisation by email",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(organisationInvitationsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("organisations:write"),
    validator("param", v.object({ organisationId: v.string() })),
    validator(
      "json",
      v.object({
        email: v.pipe(v.string(), v.email()),
        role: v.optional(
          v.union([v.literal("owner"), v.literal("admin"), v.literal("member")])
        ),
        sendMail: v.optional(v.boolean()),
      })
    ),
    isOrganisationAdmin, // check if user is admin or owner of the organisation
    async (c) => {
      try {
        const { organisationId } = c.req.valid("param");
        const { email, role = "member", sendMail = true } = c.req.valid("json");
        const invitation = await createOrganisationInvitation(
          {
            organisationId,
            email,
            role,
            status: "pending",
          },
          sendMail
        );
        return c.json(invitation);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error inviting user to organisation: " + err,
        });
      }
    }
  );

  /**
   * Add a member directly to an organisation
   */
  app.post(
    API_BASE_PATH + "/organisation/:organisationId/members",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Add a user directly to an organisation",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(organisationMembersSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("organisations:write"),
    validator("param", v.object({ organisationId: v.string() })),
    validator(
      "json",
      v.object({
        userId: v.string(),
        role: v.optional(
          v.union([v.literal("owner"), v.literal("admin"), v.literal("member")])
        ),
      })
    ),
    isOrganisationAdmin, // check if user is admin or owner of the organisation
    async (c) => {
      try {
        const { organisationId } = c.req.valid("param");
        const { userId, role = "member" } = c.req.valid("json");

        const member = await addOrganisationMember(
          organisationId,
          userId,
          role
        );
        return c.json(member);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error adding member to organisation: " + err,
        });
      }
    }
  );

  /**
   * Change the role of a member
   */
  app.put(
    API_BASE_PATH + "/organisation/:organisationId/members/:memberId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Change the role of a member",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(organisationMembersSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("organisations:write"),
    validator(
      "json",
      v.object({
        role: v.union([
          v.literal("owner"),
          v.literal("admin"),
          v.literal("member"),
        ]),
      })
    ),
    validator(
      "param",
      v.object({ organisationId: v.string(), memberId: v.string() })
    ),
    isOrganisationAdmin, // check if user is admin or owner of the organisation
    async (c) => {
      try {
        const { organisationId, memberId } = c.req.valid("param");
        const { role } = c.req.valid("json");
        const member = await updateOrganisationMemberRole(
          organisationId,
          memberId,
          role
        );
        return c.json(member);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error changing member role: " + err,
        });
      }
    }
  );

  /**
   * Remove a member from an organisation
   */
  app.delete(
    API_BASE_PATH + "/organisation/:organisationId/members/:memberId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Remove a member from an organisation",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    validateScope("organisations:write"),
    validator(
      "param",
      v.object({ organisationId: v.string(), memberId: v.string() })
    ),
    isOrganisationAdmin, // check if user is admin or owner of the organisation
    async (c) => {
      try {
        const { organisationId, memberId } = c.req.valid("param");
        await dropUserFromOrganisation(memberId, organisationId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error removing member from organisation: " + err,
        });
      }
    }
  );
}
