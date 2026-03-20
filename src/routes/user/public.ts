/**
 * Routes to register and login a user.
 * These routes are not secured and public.
 */
import type { SymbiosikaFrameworkHonoApp } from "../../types";
import { HTTPException } from "hono/http-exception";
import { LocalAuth } from "../../lib/auth";
import log from "../../lib/log";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { usersRestrictedSelectSchema } from "../../lib/db/db-schema";
import { RESPONSES } from "../../lib/responses";
import { verifyPasswordResetToken } from "../../lib/auth/magic-link";
import { checkIfInvitationCodeIsNeededToRegister } from "../../lib/usermanagement/invitations";
import { verifyApiTokenAndGetJwt } from "../../lib/auth/token-auth";
import { OAuthAuth } from "../../lib/auth/oauth2";
import {
  isPasskeysEnabledForLocalAuth,
  passkeyAuthenticationOptions,
  passkeyAuthenticationVerify,
} from "../../lib/auth/passkeys";

/**
 * Define the payment routes
 */
export function definePublicUserRoutes(
  app: SymbiosikaFrameworkHonoApp,
  API_BASE_PATH: string
) {
  /**
   * Check if an invitation code is needed to register
   */
  app.get(
    API_BASE_PATH + "/user/invitation-code-needed",
    describeRoute({
      tags: ["user"],
      summary: "Check if an invitation code is needed to register",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: v.object({
                invitationCodeNeeded: v.boolean(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      try {
        const invitationCodeNeeded =
          await checkIfInvitationCodeIsNeededToRegister();
        return c.json({ invitationCodeNeeded });
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error checking if invitation code is needed: " + err,
        });
      }
    }
  );

  /**
   * Login endpoint
   */
  app.post(
    API_BASE_PATH + "/user/login",
    describeRoute({
      tags: ["user"],
      summary: "Login endpoint",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  user: usersRestrictedSelectSchema,
                  token: v.string(),
                  redirectUrl: v.optional(v.string()),
                })
              ),
            },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        email: v.string(),
        password: v.string(),
        magicLinkToken: v.optional(v.string()),
        redirectUrl: v.optional(v.string()),
      })
    ),
    validator(
      "query",
      v.object({
        sendVerificationEmail: v.optional(v.string()), // defaults to true
      })
    ),
    async (c) => {
      try {
        if (_GLOBAL_SERVER_CONFIG.authType !== "local") {
          throw new HTTPException(400, {
            message: "Local login is not enabled",
          });
        }
        const data = c.req.valid("json");
        let sendVerificationEmail = c.req.query("sendVerificationEmail")
          ? c.req.query("sendVerificationEmail") === "true"
          : true;

        if (data.magicLinkToken) {
          const r = await LocalAuth.loginWithMagicLink(data.magicLinkToken);
          return c.json({ ...r, redirectUrl: data.redirectUrl });
        } else {
          const r = await LocalAuth.login(
            data.email,
            data.password,
            sendVerificationEmail
          );
          return c.json({ ...r, redirectUrl: data.redirectUrl });
        }
      } catch (err) {
        throw new HTTPException(401, { message: "Invalid login: " + err });
      }
    }
  );

  /**
   * Endpoint to send a magic link to the user
   */
  app.get(
    API_BASE_PATH + "/user/send-magic-link",
    describeRoute({
      tags: ["user"],
      summary: "Send a magic link to the user",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    validator(
      "query",
      v.object({
        email: v.string(),
        createUserIfMissing: v.optional(v.string()),
        invitationCode: v.optional(v.string()),
      })
    ),
    async (c) => {
      const query = c.req.valid("query");
      const email = query.email;
      const createUserIfMissing = query.createUserIfMissing === "true";
      const invitationCode = query.invitationCode;
      if (!email) {
        throw new HTTPException(400, { message: "?email=... is required" });
      }
      try {
        console.log("createUserIfMissing", createUserIfMissing);
        await LocalAuth.sendMagicLink(email, undefined, createUserIfMissing, invitationCode);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        const errorMessage = err + "";
        // Return specific error code for invitation code needed
        if (errorMessage.includes("Invitation code needed")) {
          throw new HTTPException(400, {
            message: "Invitation code needed",
          });
        }
        throw new HTTPException(500, {
          message: "Error sending magic link: " + err,
        });
      }
    }
  );

  /**
   * Endpoint to send a verification email to the user
   */
  app.get(
    API_BASE_PATH + "/user/send-verification-email",
    describeRoute({
      tags: ["user"],
      summary: "Send a verification email to the user",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    validator(
      "query",
      v.object({
        email: v.string(),
      })
    ),
    async (c) => {
      const email = c.req.query("email");
      if (!email) {
        throw new HTTPException(400, { message: "?email=... is required" });
      }
      try {
        await LocalAuth.sendVerificationEmail(email);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error sending verification email: " + err,
        });
      }
    }
  );

  /**
   * Verify email endpoint
   */
  app.get(
    API_BASE_PATH + "/user/verify-email",
    describeRoute({
      tags: ["user"],
      summary: "Verify email endpoint",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    validator(
      "query",
      v.object({
        token: v.string(),
      })
    ),
    async (c) => {
      try {
        const { token } = c.req.valid("query");
        const r = await LocalAuth.verifyEmail(token);
        return c.json(r);
      } catch (err) {
        throw new HTTPException(401, { message: "Invalid token: " + err });
      }
    }
  );

  /**
   * Register endpoint
   */
  app.post(
    API_BASE_PATH + "/user/register",
    describeRoute({
      tags: ["user"],
      summary: "Register endpoint",
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
    validator(
      "json",
      v.object({
        email: v.string(),
        password: v.string(),
        sendVerificationEmail: v.optional(v.boolean()),
        meta: v.optional(v.any()),
      })
    ),
    async (c) => {
      try {
        if (_GLOBAL_SERVER_CONFIG.authType !== "local") {
          throw new HTTPException(400, {
            message: "Local register is not enabled",
          });
        }
        const data = c.req.valid("json");
        const user = await LocalAuth.register(
          data.email,
          data.password,
          data.sendVerificationEmail ?? true,
          data.meta ?? {}
        );
        return c.json({ ...user, password: undefined, salt: undefined });
      } catch (err) {
        log.error(err + "");
        throw new HTTPException(500, { message: err + "" });
      }
    }
  );

  /**
   * Forgot password endpoint
   */
  app.post(
    API_BASE_PATH + "/user/forgot-password",
    describeRoute({
      tags: ["user"],
      summary: "Forgot password endpoint",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    validator(
      "json",
      v.object({
        email: v.string(),
      })
    ),
    validator(
      "query",
      v.object({
        type: v.optional(v.string()),
      })
    ),
    async (c) => {
      try {
        const { email } = c.req.valid("json");
        const { type } = c.req.valid("query");

        const welcomeText = type && type === "welcome" ? true : false;

        await LocalAuth.forgotPasswort(email, welcomeText);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error sending forgot password email: " + err,
        });
      }
    }
  );

  /**
   * Set new password with token
   */
  app.post(
    API_BASE_PATH + "/user/reset-password",
    describeRoute({
      tags: ["user"],
      summary: "Reset password with token",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    validator(
      "json",
      v.object({
        token: v.string(),
        password: v.string(),
      })
    ),
    async (c) => {
      try {
        const { token, password } = c.req.valid("json");
        const { userId } = await verifyPasswordResetToken(token);

        await LocalAuth.setNewPassword(userId, password);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(401, { message: "Invalid token: " + err });
      }
    }
  );

  /**
   * API Token Exchange endpoint
   * Allows exchanging a long-lived API token for a short-lived JWT with specific scopes
   */
  app.post(
    API_BASE_PATH + "/user/token-exchange",
    describeRoute({
      tags: ["user"],
      summary: "Exchange API token for a short-lived JWT",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: v.object({
                token: v.string(),
                expiresAt: v.string(),
              }),
            },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        token: v.string(),
        scopes: v.optional(v.array(v.string())),
      })
    ),
    async (c) => {
      try {
        const { token, scopes } = c.req.valid("json");
        const jwt = await verifyApiTokenAndGetJwt(token, scopes);

        return c.json({
          token: jwt.token,
          expiresAt: jwt.expiresAt.toISOString(),
        });
      } catch (err) {
        throw new HTTPException(401, {
          message: err + "",
        });
      }
    }
  );

  /**
   * WebAuthn: begin passkey authentication (local auth; RP ID from BASE_URL hostname)
   */
  app.post(
    API_BASE_PATH + "/user/passkey/authentication/options",
    describeRoute({
      tags: ["user"],
      summary: "Begin passkey sign-in (returns WebAuthn request options)",
      responses: {
        200: { description: "PublicKeyCredentialRequestOptions + challenge token" },
      },
    }),
    validator(
      "json",
      v.object({
        email: v.string(),
      })
    ),
    async (c) => {
      if (!isPasskeysEnabledForLocalAuth()) {
        throw new HTTPException(404, { message: "Passkeys are not enabled" });
      }
      try {
        const { email } = c.req.valid("json");
        const r = await passkeyAuthenticationOptions(c, email);
        return c.json({
          options: r.options,
          challengeToken: r.challengeToken,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new HTTPException(400, { message });
      }
    }
  );

  /**
   * WebAuthn: finish passkey authentication and issue JWT
   */
  app.post(
    API_BASE_PATH + "/user/passkey/authentication/verify",
    describeRoute({
      tags: ["user"],
      summary: "Complete passkey sign-in",
      responses: {
        200: {
          description: "JWT and user profile",
        },
      },
    }),
    validator(
      "json",
      v.object({
        challengeToken: v.string(),
        credential: v.any(),
      })
    ),
    async (c) => {
      if (!isPasskeysEnabledForLocalAuth()) {
        throw new HTTPException(404, { message: "Passkeys are not enabled" });
      }
      try {
        const body = c.req.valid("json");
        const r = await passkeyAuthenticationVerify(c, {
          challengeToken: body.challengeToken,
          credential: body.credential,
        });
        return c.json({
          token: r.token,
          expiresAt: r.expiresAt.toISOString(),
          user: r.user,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new HTTPException(400, { message });
      }
    }
  );

  /**
   * Get available OAuth providers
   */
  app.get(
    API_BASE_PATH + "/user/oauth-providers",
    describeRoute({
      tags: ["user"],
      summary: "Get available OAuth providers",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    async (c) => {
      return c.json(OAuthAuth.getAvailableOAuthProviders());
    }
  );

  /**
   * OAuth Google authentication redirect
   */
  app.get(
    API_BASE_PATH + "/user/auth/:provider",
    describeRoute({
      tags: ["user"],
      summary: "Redirect to Google authentication",
      responses: {
        302: { description: "Redirect to Google OAuth" },
      },
    }),
    validator(
      "query",
      v.object({
        redirectUrl: v.optional(v.string()),
      })
    ),
    validator(
      "param",
      v.object({
        provider: v.string(),
      })
    ),
    async (c) => {
      try {
        const provider = c.req.valid("param").provider;
        const redirectUrl = c.req.query("redirectUrl") || "";
        let authUrl;
        if (provider === "google") {
          authUrl = OAuthAuth.getGoogleAuthUrl();
        } else if (provider === "microsoft") {
          authUrl = OAuthAuth.getMicrosoftAuthUrl();
        } else {
          throw new Error("Invalid provider");
        }
        return c.redirect(authUrl);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error redirecting to Google auth: " + err,
        });
      }
    }
  );

  /**
   * OAuth Microsoft callback
   */
  app.get(
    API_BASE_PATH + "/user/auth/:provider/callback",
    describeRoute({
      tags: ["user"],
      summary: "Handle Microsoft OAuth callback",
      responses: {
        200: {
          description: "Successful authentication",
          content: {
            "application/json": {
              schema: v.object({
                token: v.string(),
                expiresAt: v.string(),
                user: usersRestrictedSelectSchema,
              }),
            },
          },
        },
      },
    }),
    validator(
      "query",
      v.object({
        code: v.string(),
        state: v.optional(v.string()),
      })
    ),
    validator(
      "param",
      v.object({
        provider: v.string(),
      })
    ),
    async (c) => {
      try {
        const provider = c.req.valid("param").provider;
        const code = c.req.query("code");
        if (!code) {
          throw new Error("No code provided");
        }

        let result;
        if (provider === "microsoft") {
          result = await OAuthAuth.handleMicrosoftCallback(code);
        } else if (provider === "google") {
          result = await OAuthAuth.handleGoogleCallback(code);
        } else {
          throw new Error("Invalid provider");
        }

        return c.redirect(
          `${_GLOBAL_SERVER_CONFIG.oauthCallbackUrl}/${provider}?token=${result.token}`
        );
      } catch (err) {
        throw new HTTPException(401, {
          message: "Failed to authenticate with Microsoft: " + err,
        });
      }
    }
  );
}
