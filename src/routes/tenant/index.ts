/**
 * Routes to manage tenants
 * These routes are for the admin of the tenant and normally not used by a SPA or any Frontend
 */
import type { SymbiosikaFrameworkHonoApp } from "../../types";
import { HTTPException } from "hono/http-exception";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../lib/utils/hono-middlewares";
import {
  createTenant,
  getTenant,
  updateTenant,
  deleteTenant,
  getTenantMembers,
  addTenantMember,
  dropUserFromTenant,
  getUserTenants,
  getTenantMemberRole,
  updateTenantMemberRole,
} from "../../lib/usermanagement/tenants";
import { RESPONSES } from "../../lib/responses";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import {
  tenantInvitationsSelectSchema,
  tenantMembersSelectSchema,
  tenantsInsertSchema,
  tenantsSelectSchema,
  tenantsUpdateSchema,
} from "../../lib/db/db-schema";
import { createTenantInvitation } from "../../lib/usermanagement/invitations";
import type { MiddlewareHandler } from "hono";
import { validateScope } from "../../lib/utils/validate-scope";

/**
 * Middleware to check if user is a member of the tenant
 */
export const isTenantMember: MiddlewareHandler = async (c, next) => {
  const userId = c.get("usersId");
  const tenantId = c.req.param("tenantId")!;

  // A connection token (cert-authenticated server-to-server link) may act for
  // the tenant named in its own claim — no tenant membership row required.
  if (
    c.get("tokenType") === "connection" &&
    c.get("tokenTenantId") === tenantId
  ) {
    await next();
    return;
  }

  try {
    await getTenantMemberRole(tenantId, userId);
    await next();
  } catch (err) {
    throw new HTTPException(403, {
      message: "User is not a member of this tenant",
    });
  }
};

/**
 * Middleware to check if user is an admin or owner of the tenant
 */
export const isTenantAdmin: MiddlewareHandler = async (c, next) => {
  const userId = c.get("usersId");
  const tenantId = c.req.param("tenantId")!;

  try {
    const role = await getTenantMemberRole(tenantId, userId);
    if (role !== "admin" && role !== "owner") {
      throw new HTTPException(403, {
        message: "User is not an admin or owner of this tenant",
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
 * Helper to check that an key of an object is the same as the tenantId
 */
export const checkTenantIdInBody: MiddlewareHandler = async (c, next) => {
  const tenantId = c.req.param("tenantId");
  // @ts-ignore
  const json: { tenantId: string } = c.req.valid("json");

  if (!json.tenantId || !tenantId || json.tenantId !== tenantId) {
    throw new HTTPException(403, {
      message:
        "The tenantId in the body does not match the tenantId in the path",
    });
  }
  await next();
};

export default function defineTenantRoutes(
  app: SymbiosikaFrameworkHonoApp,
  API_BASE_PATH: string
) {
  /**
   * Create a new tenant
   */
  app.post(
    API_BASE_PATH + "/tenant",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Create a new tenant",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(tenantsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("tenants:write"),
    validator("json", tenantsInsertSchema),
    async (c) => {
      try {
        const data = c.req.valid("json");
        const userId = c.get("usersId");
        // check if the user has already an tenant
        const userTenants = await getUserTenants(userId);
        if (userTenants.length > 0) {
          throw new HTTPException(400, {
            message: "User already has an tenant",
          });
        }

        // create the tenant
        const tenant = await createTenant(data);
        // put the user in the tenant
        await addTenantMember(tenant.id, userId, "owner");
        return c.json(tenant);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error creating tenant: " + err,
        });
      }
    }
  );

  /**
   * Get an tenant
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Get an tenant",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(tenantsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("tenants:read"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { tenantId } = c.req.valid("param");
        const tenant = await getTenant(tenantId);
        return c.json(tenant);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting tenant: " + err,
        });
      }
    }
  );

  /**
   * Get all members of an tenant
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/members",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Get all members of an tenant",
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
    validateScope("tenants:read"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember, // check if user is a member of the tenant
    async (c) => {
      const userId = c.get("usersId");
      const { tenantId } = c.req.valid("param");
      const members = await getTenantMembers(userId, tenantId);
      return c.json(members);
    }
  );

  /**
   * Update an tenant
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Update an tenant",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(tenantsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("tenants:write"),
    validator("json", tenantsUpdateSchema),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantAdmin, // check if user is admin or owner of the tenant
    async (c) => {
      try {
        const data = c.req.valid("json");
        const tenant = await updateTenant(c.req.valid("param").tenantId, data);
        return c.json(tenant);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error updating tenant: " + err,
        });
      }
    }
  );

  /**
   * Delete an tenant
   */
  app.delete(
    API_BASE_PATH + "/tenant/:tenantId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Delete an tenant",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    validateScope("tenants:write"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantAdmin, // check if user is admin or owner of the tenant
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        await deleteTenant(tenantId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error deleting tenant: " + err,
        });
      }
    }
  );

  /**
   * Invite a user to an tenant
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/invite",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Invite a user to an tenant by email",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(tenantInvitationsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("tenants:write"),
    validator("param", v.object({ tenantId: v.string() })),
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
    isTenantAdmin, // check if user is admin or owner of the tenant
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const { email, role = "member", sendMail = true } = c.req.valid("json");
        const invitation = await createTenantInvitation(
          {
            tenantId,
            email,
            role,
            status: "pending",
          },
          sendMail
        );
        return c.json(invitation);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error inviting user to tenant: " + err,
        });
      }
    }
  );

  /**
   * Add a member directly to an tenant
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/members",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Add a user directly to an tenant",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(tenantMembersSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("tenants:write"),
    validator("param", v.object({ tenantId: v.string() })),
    validator(
      "json",
      v.object({
        userId: v.string(),
        role: v.optional(
          v.union([v.literal("owner"), v.literal("admin"), v.literal("member")])
        ),
      })
    ),
    isTenantAdmin, // check if user is admin or owner of the tenant
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const { userId, role = "member" } = c.req.valid("json");

        const member = await addTenantMember(tenantId, userId, role);
        return c.json(member);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error adding member to tenant: " + err,
        });
      }
    }
  );

  /**
   * Change the role of a member
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/members/:memberId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Change the role of a member",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(tenantMembersSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("tenants:write"),
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
      v.object({ tenantId: v.string(), memberId: v.string() })
    ),
    isTenantAdmin, // check if user is admin or owner of the tenant
    async (c) => {
      try {
        const { tenantId, memberId } = c.req.valid("param");
        const { role } = c.req.valid("json");
        const member = await updateTenantMemberRole(tenantId, memberId, role);
        return c.json(member);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error changing member role: " + err,
        });
      }
    }
  );

  /**
   * Remove a member from an tenant
   */
  app.delete(
    API_BASE_PATH + "/tenant/:tenantId/members/:memberId",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      summary: "Remove a member from an tenant",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    validateScope("tenants:write"),
    validator(
      "param",
      v.object({ tenantId: v.string(), memberId: v.string() })
    ),
    isTenantAdmin, // check if user is admin or owner of the tenant
    async (c) => {
      try {
        const { tenantId, memberId } = c.req.valid("param");
        await dropUserFromTenant(memberId, tenantId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error removing member from tenant: " + err,
        });
      }
    }
  );
}
