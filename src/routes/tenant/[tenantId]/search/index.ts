/**
 * Routes to manage the secrets of an tenant
 * These routes are protected by JWT and CheckPermission middleware
 */
import { HTTPException } from "../../../../types";
import { authAndSetUsersInfo } from "../../../../lib/utils/hono-middlewares";
import type { FastAppHono } from "../../../../types";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { describeRoute } from "hono-openapi";
import { getUserByEmail } from "../../../../lib/usermanagement/user";
import { isOrganisationMember } from "../..";
import { validateScope } from "../../../../lib/utils/validate-scope";

/**
 * Define the backend secret management routes
 */
export default function defineSearchInOrganisationRoutes(
  app: FastAppHono,
  API_BASE_PATH: string
) {
  /**
   * Search for users by email address inside an tenant
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/search/user",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["search"],
      summary: "Search for users by email address inside an tenant",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  id: v.string(),
                  email: v.string(),
                  firstname: v.string(),
                  surname: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("tenants:read"),
    validator(
      "query",
      v.object({
        email: v.string(),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    isOrganisationMember,
    async (c) => {
      try {
        const email = c.req.valid("query").email;
        const { tenantId } = c.req.valid("param");
        const u = await getUserByEmail(email, tenantId);
        return c.json({
          id: u.id,
          email: u.email,
          firstname: u.firstname,
          surname: u.surname,
        });
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting user by email: " + err,
        });
      }
    }
  );
}
