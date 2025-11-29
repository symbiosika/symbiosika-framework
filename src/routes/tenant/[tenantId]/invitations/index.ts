/**
 * Routes to manage the invitations of an tenant
 * These routes are protected by JWT and CheckPermission middleware
 */

import type { FastAppHono } from "../../../../types";
import { HTTPException } from "hono/http-exception";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../lib/utils/hono-middlewares";
import {
  getAllTenantInvitations,
  acceptTenantInvitation,
  declineTenantInvitation,
  createTenantInvitation,
  acceptAllPendingInvitationsForTenantMember,
  dropTenantInvitation,
  declineAllPendingInvitationsForTenantMember,
} from "../../../../lib/usermanagement/invitations";
import * as v from "valibot";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import {
  tenantInvitationsInsertSchema,
  tenantInvitationsSelectSchema,
} from "../../../../lib/db/db-schema";
import { RESPONSES } from "../../../../lib/responses";
import { checkTenantIdInBody, isTenantAdmin } from "../..";
import { validateScope } from "../../../../lib/utils/validate-scope";

export default function defineInvitationsRoutes(
  app: FastAppHono,
  API_BASE_PATH: string
) {
  /**
   * Create a new invitation
   * This can only be done by the tenant admin
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/invitations",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["invitations"],
      summary: "Create a new invitation",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  id: v.string(),
                  tenantId: v.string(),
                  tenantName: v.string(),
                  email: v.string(),
                  status: v.string(),
                  role: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("tenants:write"),
    validator("json", tenantInvitationsInsertSchema),
    validator("param", v.object({ tenantId: v.string() })),
    validator("query", v.object({ sendMail: v.optional(v.string()) })),
    checkTenantIdInBody,
    isTenantAdmin,
    async (c) => {
      try {
        const data = c.req.valid("json");
        // If sendMail is not set, it defaults to true
        const sendMail = c.req.valid("query").sendMail
          ? c.req.valid("query").sendMail === "true"
          : true;
        const invitation = await createTenantInvitation(data, sendMail);
        return c.json(invitation);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error creating invitation: " + err,
        });
      }
    }
  );

  /**
   * Get all invitations of an tenant to manage them as an admin overview
   * This path is not for a user to get his own invitations
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/invitations",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["invitations"],
      summary:
        "Get all invitations of an tenant to manage them as an admin overview. This path is not for a user to get his own invitations.",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(v.array(tenantInvitationsSelectSchema)),
            },
          },
        },
      },
    }),
    validateScope("tenants:read"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantAdmin,
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const invitations = await getAllTenantInvitations(tenantId);
        return c.json(invitations);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting invitations: " + err,
        });
      }
    }
  );

  /**
   * Drop an invitation by its ID
   * This can only be done by the tenant admin
   */
  app.delete(
    API_BASE_PATH + "/tenant/:tenantId/invitations/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["invitations"],
      summary: "Drop an invitation by its ID",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("tenants:write"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await dropTenantInvitation(id);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error dropping invitation: " + err,
        });
      }
    }
  );

  /**
   * Accept an invitation by the User himself
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/invitations/:id/accept",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["invitations"],
      summary: "Accept an invitation by the User himself",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("tenants:write"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        if (id.toLowerCase() === "all") {
          await acceptAllPendingInvitationsForTenantMember(userId, tenantId);
        } else {
          await acceptTenantInvitation(id, userId, tenantId);
        }
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error accepting invitation: " + err,
        });
      }
    }
  );

  /**
   * Decline an invitation
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/invitations/:id/decline",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["invitations"],
      summary: "Decline an invitation",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("tenants:write"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        if (id.toLowerCase() === "all") {
          await declineAllPendingInvitationsForTenantMember(
            c.get("usersId"),
            tenantId
          );
        } else {
          await declineTenantInvitation(id);
        }

        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error declining invitation: " + err,
        });
      }
    }
  );
}
