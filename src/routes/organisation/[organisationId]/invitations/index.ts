/**
 * Routes to manage the invitations of an organisation
 * These routes are protected by JWT and CheckPermission middleware
 */

import type { FastAppHono } from "../../../../types";
import { HTTPException } from "hono/http-exception";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../lib/utils/hono-middlewares";
import {
  getAllOrganisationInvitations,
  acceptOrganisationInvitation,
  declineOrganisationInvitation,
  createOrganisationInvitation,
  acceptAllPendingInvitationsForUser,
  dropOrganisationInvitation,
  declineAllPendingInvitationsForUser,
} from "../../../../lib/usermanagement/invitations";
import * as v from "valibot";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import {
  organisationInvitationsInsertSchema,
  organisationInvitationsSelectSchema,
} from "../../../../lib/db/db-schema";
import { RESPONSES } from "../../../../lib/responses";
import { checkOrganisationIdInBody, isOrganisationAdmin } from "../..";
import { validateScope } from "../../../../lib/utils/validate-scope";

export default function defineInvitationsRoutes(
  app: FastAppHono,
  API_BASE_PATH: string
) {
  /**
   * Create a new invitation
   * This can only be done by the organisation admin
   */
  app.post(
    API_BASE_PATH + "/organisation/:organisationId/invitations",
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
                  organisationId: v.string(),
                  organisationName: v.string(),
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
    validateScope("organisations:write"),
    validator("json", organisationInvitationsInsertSchema),
    validator("param", v.object({ organisationId: v.string() })),
    validator("query", v.object({ sendMail: v.optional(v.string()) })),
    checkOrganisationIdInBody,
    isOrganisationAdmin,
    async (c) => {
      try {
        const data = c.req.valid("json");
        // If sendMail is not set, it defaults to true
        const sendMail = c.req.valid("query").sendMail
          ? c.req.valid("query").sendMail === "true"
          : true;
        const invitation = await createOrganisationInvitation(data, sendMail);
        return c.json(invitation);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error creating invitation: " + err,
        });
      }
    }
  );

  /**
   * Get all invitations of an organisation to manage them as an admin overview
   * This path is not for a user to get his own invitations
   */
  app.get(
    API_BASE_PATH + "/organisation/:organisationId/invitations",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["invitations"],
      summary:
        "Get all invitations of an organisation to manage them as an admin overview. This path is not for a user to get his own invitations.",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(v.array(organisationInvitationsSelectSchema)),
            },
          },
        },
      },
    }),
    validateScope("organisations:read"),
    validator("param", v.object({ organisationId: v.string() })),
    isOrganisationAdmin,
    async (c) => {
      try {
        const { organisationId } = c.req.valid("param");
        const invitations = await getAllOrganisationInvitations(organisationId);
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
   * This can only be done by the organisation admin
   */
  app.delete(
    API_BASE_PATH + "/organisation/:organisationId/invitations/:id",
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
    validateScope("organisations:write"),
    validator(
      "param",
      v.object({ organisationId: v.string(), id: v.string() })
    ),
    isOrganisationAdmin,
    async (c) => {
      try {
        const { organisationId, id } = c.req.valid("param");
        await dropOrganisationInvitation(id);
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
    API_BASE_PATH + "/organisation/:organisationId/invitations/:id/accept",
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
    validateScope("organisations:write"),
    validator(
      "param",
      v.object({ organisationId: v.string(), id: v.string() })
    ),
    async (c) => {
      try {
        const { organisationId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        if (id.toLowerCase() === "all") {
          await acceptAllPendingInvitationsForUser(userId, organisationId);
        } else {
          await acceptOrganisationInvitation(id, userId, organisationId);
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
    API_BASE_PATH + "/organisation/:organisationId/invitations/:id/decline",
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
    validateScope("organisations:write"),
    validator(
      "param",
      v.object({ organisationId: v.string(), id: v.string() })
    ),
    async (c) => {
      try {
        const { organisationId, id } = c.req.valid("param");
        if (id.toLowerCase() === "all") {
          await declineAllPendingInvitationsForUser(
            c.get("usersId"),
            organisationId
          );
        } else {
          await declineOrganisationInvitation(id);
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
