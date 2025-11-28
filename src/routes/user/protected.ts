/**
 * Routes that a user can interact with himself.
 * These routes are secured by JWT.
 * These routes are note protected by the RegEx PermissionChecker since the scope is only the user itself.
 */

import type {
  CustomPostRegisterAction,
  CustomPreRegisterVerification,
  FastAppHono,
} from "../../types";
import { HTTPException } from "hono/http-exception";
import {
  tenantInvitationsSelectSchema,
  tenants,
  tenantsSelectSchema,
  usersRestrictedSelectSchema,
} from "../../lib/db/db-schema";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../lib/utils/hono-middlewares";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import {
  addTenantMember,
  createTenant,
  dropUserFromTenant,
  getLastTenant,
  getTenantMemberRole,
  getUserTenants,
  setLastTenant,
} from "../../lib/usermanagement/tenants";
import {
  dropUserFromTeam,
  getTeamsByUser,
} from "../../lib/usermanagement/teams";
import * as v from "valibot";
import { LocalAuth } from "../../lib/auth";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import {
  getUserByEmail,
  getUserById,
  updateUser,
} from "../../lib/usermanagement/user";
import { getUsersTenantInvitations } from "../../lib/usermanagement/invitations";
import { RESPONSES } from "../../lib/responses";
import {
  createApiToken,
  listApiTokensForUser,
  revokeApiToken,
} from "../../lib/auth/token-auth";
import {
  getUserProfileImage,
  upsertUserProfileImage,
} from "../../lib/usermanagement/profile-image";
import { validateScope } from "../../lib/utils/validate-scope";
import { availableScopes } from "../../lib/auth/available-scopes";
import { sendValidationPin, validatePhoneNumber } from "../../lib/auth/phone";

/**
 * Pre-register custom verification
 */
const preRegisterCustomVerifications: CustomPreRegisterVerification[] = [];
const postRegisterActions: CustomPostRegisterAction[] = [];

/**
 * Register new verification
 */
export const registerPreRegisterCustomVerification = (
  verification: CustomPreRegisterVerification
) => {
  preRegisterCustomVerifications.push(verification);
};

/**
 * Register new post-register action
 */
export const registerPostRegisterAction = (
  action: CustomPostRegisterAction
) => {
  postRegisterActions.push(action);
};

/**
 * Define the payment routes
 */
export function defineSecuredUserRoutes(
  app: FastAppHono,
  API_BASE_PATH: string
) {
  /**
   * Get the own user
   */
  app.get(
    API_BASE_PATH + "/user/me",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user"],
      summary: "Get the own user",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(usersRestrictedSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("user:read"),
    async (c) => {
      try {
        // check if id is set
        const uid = c.get("usersId");
        const user = await getUserById(uid);
        const scopes = c.get("scopes");

        return c.json(user);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting user: " + err,
        });
      }
    }
  );

  /**
   * Update the own user
   */
  app.put(
    API_BASE_PATH + "/user/me",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user"],
      summary: "Update the own user",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(usersRestrictedSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("user:write"),
    validator(
      "json",
      v.object({
        firstname: v.optional(v.string()),
        surname: v.optional(v.string()),
        image: v.optional(v.nullable(v.string())),
        lastTenantId: v.optional(v.nullable(v.string())),
        phoneNumber: v.optional(v.nullable(v.string())),
      })
    ),
    async (c) => {
      try {
        // ensure to get only the allowed fields
        const { firstname, surname, image, lastTenantId, phoneNumber } =
          c.req.valid("json");
        await updateUser(c.get("usersId"), {
          firstname,
          surname,
          image,
          lastTenantId,
          phoneNumber,
        });
        const user = await getUserById(c.get("usersId"));
        return c.json(user);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error updating user: " + err,
        });
      }
    }
  );

  /**
   * Upload/Update profile image
   */
  app.post(
    API_BASE_PATH + "/user/profile-image",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["users"],
      summary: "Upload or update user profile image",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  success: v.boolean(),
                  message: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("user:write"),
    validator(
      "form",
      v.object({
        file: v.any(),
      })
    ),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const form = c.req.valid("form");
        const file = form.file;

        if (!file) {
          throw new HTTPException(400, { message: "No file provided" });
        }
        await upsertUserProfileImage(userId, file);

        return c.json({
          success: true,
          message: "Profile image set successfully",
        });
      } catch (err) {
        throw new HTTPException(400, { message: err + "" });
      }
    }
  );

  /**
   * Get user profile image
   */
  app.get(
    API_BASE_PATH + "/user/profile-image",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["users"],
      summary: "Get user profile image",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("user:read"),
    async (c) => {
      try {
        const userId = c.get("usersId");
        // Get the profile image from database
        const image = await getUserProfileImage(userId);
        return new Response(image.file, {
          status: 200,
          headers: {
            "Content-Type": image.contentType,
          },
        });
      } catch (err) {
        throw new HTTPException(400, { message: err + "" });
      }
    }
  );

  /**
   * A "setup" route that will give the use the possibility to setup the first tenant
   * if the user has no tenant yet.
   */
  app.post(
    API_BASE_PATH + "/user/setup",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user"],
      summary:
        "Setup the user's first tenant. Can throw an error if the user already has an tenant and this is not allowed",
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
    validateScope("user:write"),
    validator(
      "json",
      v.object({
        tenantName: v.string(),
      })
    ),
    async (c) => {
      try {
        const userId = c.get("usersId");
        // check if user has an tenant
        // with the setup-endpoint a user can only register his first tenant if he has no tenant yet
        const tenants = await getUserTenants(userId);
        if (tenants.length > 0) {
          return c.json({ state: "already-setup" });
        }
        const parsed = c.req.valid("json");
        const tenant = await createTenant({
          name: parsed.tenantName,
        });
        await addTenantMember(tenant.id, userId, "admin");
        await setLastTenant(userId, tenant.id);

        return c.json(tenant);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error creating tenant: " + err,
        });
      }
    }
  );

  /**
   * Change the own password
   */
  app.put(
    API_BASE_PATH + "/user/me/password",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user"],
      summary: "Change the own password",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("user:write"),
    validator(
      "json",
      v.object({
        oldPassword: v.string(),
        newPassword: v.string(),
      })
    ),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const user = await getUserById(userId);
        if (!user) {
          throw new HTTPException(404, { message: "User not found" });
        }
        const { oldPassword, newPassword } = c.req.valid("json");
        await LocalAuth.changePassword(user.email, oldPassword, newPassword);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error changing password: " + err,
        });
      }
    }
  );

  /**
   * Get the user's tenants
   */
  app.get(
    API_BASE_PATH + "/user/tenants",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user", "tenants"],
      summary: "Get the user's tenants",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    tenantId: v.string(),
                    name: v.string(),
                    role: v.string(),
                  })
                )
              ),
            },
          },
        },
      },
    }),
    validateScope("user:read"),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const tenants = await getUserTenants(userId);
        return c.json(tenants);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting user tenants: " + err,
        });
      }
    }
  );

  /**
   * Get all pending invitations for my user
   */
  app.get(
    API_BASE_PATH + "/user/tenants/invitations",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["invitations"],
      summary: "Get all pending invitations for my user",
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
    validateScope("user:read"),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const invitations = await getUsersTenantInvitations(userId);
        return c.json(invitations);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting invitations: " + err,
        });
      }
    }
  );

  /**
   * Drop the membership of a user itself from an tenant
   */
  app.delete(
    API_BASE_PATH + "/user/tenant/:tenantId/membership",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user", "tenants"],
      summary: "Drop the membership of the user itself from an tenant",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    validateScope("user:write"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
      })
    ),
    async (c) => {
      const userId = c.get("usersId");
      const { tenantId } = c.req.valid("param");
      try {
        await dropUserFromTenant(userId, tenantId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error dropping user from tenant: " + err,
        });
      }
    }
  );

  /**
   * Get the user's teams
   */
  app.get(
    API_BASE_PATH + "/user/tenant/:tenantId/teams",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user", "teams"],
      summary: "Get the user's teams",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    teamId: v.string(),
                    name: v.string(),
                    role: v.string(),
                  })
                )
              ),
            },
          },
        },
      },
    }),
    validateScope("user:read"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
      })
    ),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { tenantId } = c.req.valid("param");
        const teams = await getTeamsByUser(userId, tenantId);
        return c.json(teams);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting user teams: " + err,
        });
      }
    }
  );

  /**
   * Drop the membership of the user itself from a team
   */
  app.delete(
    API_BASE_PATH + "/user/tenant/:tenantId/teams/:teamId/membership",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user", "teams"],
      summary: "Drop the membership of the user itself from a team",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("user:write"),
    validator(
      "param",
      v.object({
        teamId: v.string(),
      })
    ),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { teamId } = c.req.valid("param");
        await dropUserFromTeam(userId, teamId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error dropping user from team: " + err,
        });
      }
    }
  );

  /**
   * Get the user's last tenant
   */
  app.get(
    API_BASE_PATH + "/user/last-tenant",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user"],
      summary: "Get the user's last tenant",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  userId: v.string(),
                  lastOrganisationId: v.string(),
                  tenantName: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("user:read"),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const tenant = await getLastTenant(userId);
        return c.json(tenant);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting last tenant: " + err,
        });
      }
    }
  );

  /**
   * Set the user's last tenant
   */
  app.put(
    API_BASE_PATH + "/user/last-tenant",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user"],
      summary: "Set the user's last tenant",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  userId: v.string(),
                  lastTenantId: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("user:write"),
    validator(
      "json",
      v.object({
        tenantId: v.string(),
      })
    ),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const tenantId = c.req.valid("json").tenantId;
        const result = await setLastTenant(userId, tenantId);
        return c.json(result);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error setting last tenant: " + err,
        });
      }
    }
  );

  /**
   * Search for users by email address
   */
  app.get(
    API_BASE_PATH + "/user/search",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user"],
      summary: "Search for users by email address in the whole Application",
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
    validateScope("user:read"),
    validator(
      "query",
      v.object({
        email: v.string(),
      })
    ),
    async (c) => {
      try {
        const email = c.req.valid("query").email;
        const u = await getUserByEmail(email);
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

  /**
   * Refresh the own token
   */
  app.get(
    API_BASE_PATH + "/user/refresh-token",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user"],
      summary: "Refresh the own token",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  token: v.string(),
                  expiresAt: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("user:read"),
    async (c) => {
      try {
        const userId = c.get("usersId");
        // require a new token. Only a valid logged in user can get this endpoint
        const newTokenData = await LocalAuth.refreshToken(userId);
        return c.json(newTokenData);
      } catch (error) {
        throw new HTTPException(401, {
          message: "Token-Refresh fehlgeschlagen: " + error,
        });
      }
    }
  );

  /**
   * Get all available scopes for creating a new API token
   */
  app.get(
    API_BASE_PATH + "/user/api-tokens/available-scopes",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user", "api-tokens"],
      summary: "Get all available scopes for creating a new API token",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  all: v.array(v.string()),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("user:read"),
    async (c) => {
      return c.json(availableScopes);
    }
  );

  /**
   * Create a new API token
   */
  app.post(
    API_BASE_PATH + "/user/api-tokens",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user", "api-tokens"],
      summary:
        "Create a new API token for the authenticated user. Set expiredIn in minutes.",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  token: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("user:write"),
    validator(
      "json",
      v.object({
        name: v.string(),
        scopes: v.array(v.string()),
        expiresIn: v.optional(v.number()),
        tenantId: v.string(),
      })
    ),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { name, scopes, expiresIn, tenantId } = c.req.valid("json");

        // check if user is part of that tenant. would throw an error if not
        await getTenantMemberRole(tenantId, userId);

        const result = await createApiToken({
          name,
          userId,
          tenantId,
          scopes,
          expiresIn,
        });

        return c.json(result);
      } catch (err) {
        throw new HTTPException(500, {
          message: err + "",
        });
      }
    }
  );

  /**
   * List all API tokens for the authenticated user
   */
  app.get(
    API_BASE_PATH + "/user/api-tokens",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user", "api-tokens"],
      summary: "List all API tokens for the authenticated user",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    id: v.string(),
                    name: v.string(),
                    scopes: v.array(v.string()),
                    lastUsed: v.optional(v.string()),
                    expiresAt: v.optional(v.string()),
                    createdAt: v.string(),
                    tenantId: v.string(),
                  })
                )
              ),
            },
          },
        },
      },
    }),
    validateScope("user:read"),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const tokens = await listApiTokensForUser(userId);
        return c.json(tokens);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error listing API tokens: " + err,
        });
      }
    }
  );

  /**
   * Revoke (delete) an API token
   */
  app.delete(
    API_BASE_PATH + "/user/api-tokens/:tokenId",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user", "api-tokens"],
      summary: "Revoke (delete) an API token",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("user:write"),
    validator(
      "param",
      v.object({
        tokenId: v.string(),
      })
    ),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { tokenId } = c.req.valid("param");

        await revokeApiToken(tokenId, userId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error revoking API token: " + err,
        });
      }
    }
  );

  /**
   * Start phone number validation by sending a PIN code via WhatsApp
   */
  app.post(
    API_BASE_PATH + "/user/start-phone-validation",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user"],
      summary:
        "Start phone number validation process by sending a PIN code via WhatsApp",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  message: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("user:write"),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const result = await sendValidationPin(userId);
        return c.json(result);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error starting phone validation: " + err,
        });
      }
    }
  );

  /**
   * Validate phone number with PIN
   */
  app.get(
    API_BASE_PATH + "/user/validate-phone",
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user"],
      summary: "Validate phone number with PIN",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  success: v.boolean(),
                  message: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("user:write"),
    validator(
      "query",
      v.object({
        pin: v.string(),
      })
    ),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { pin } = c.req.valid("query");

        const result = await validatePhoneNumber(userId, pin);
        return c.json(result);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error validating phone number: " + err,
        });
      }
    }
  );
}
