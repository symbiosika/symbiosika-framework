/**
 * Routes to register and login a user.
 * These routes are not secured and public.
 */
import type { SymbiosikaFrameworkHonoApp } from "../../types";
import { HTTPException } from "hono/http-exception";
import { LocalAuth, createJwtSessionForUserId } from "../../lib/auth";
import { sendEmailLoginCode, verifyEmailLoginCode } from "../../lib/auth/email-otp";
import log from "../../lib/log";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { usersRestrictedSelectSchema } from "../../lib/db/db-schema";
import { RESPONSES } from "../../lib/responses";
import { verifyPasswordResetToken } from "../../lib/auth/magic-link";
import {
  checkIfInvitationCodeIsNeededToRegister,
  acceptInvitationByToken,
} from "../../lib/usermanagement/invitations";
import { verifyApiTokenAndGetJwt } from "../../lib/auth/token-auth";
import {
  OAUTH_LOGIN_TX_COOKIE,
  OAUTH_LOGIN_TX_TTL_SECONDS,
  OAuthAuth,
  createOAuthCodeChallenge,
  createOAuthRandomToken,
  decodeOAuthTransaction,
  encodeOAuthTransaction,
  isOAuthProvider,
  isOAuthProviderActive,
  isSameOAuthState,
  sanitizeOAuthRedirect,
} from "../../lib/auth/oauth2";
import {
  isPasskeysEnabledForLocalAuth,
  passkeyAuthenticationOptions,
  passkeyAuthenticationVerify,
} from "../../lib/auth/passkeys";
import {
  setAuthCookies,
  clearAuthCookies,
  JWT_COOKIE_NAME,
} from "../../lib/auth/auth-cookies";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { revokeSessionByToken } from "../../lib/auth/sessions";
import { deleteCachedToken } from "../../lib/utils/redis-cache";

/**
 * Error codes a failed social login appends to the login page URL. The page
 * turns them into a message; no server-side detail leaks into the browser.
 */
export type OAuthLoginError =
  | "oauth_unavailable"
  | "oauth_cancelled"
  | "oauth_failed";

const oauthLoginError = (error: OAuthLoginError) =>
  `${_GLOBAL_SERVER_CONFIG.loginUrl}?error=${error}`;

const isSecureContext = () =>
  _GLOBAL_SERVER_CONFIG.baseUrl.startsWith("https://");

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
          setAuthCookies(c, r.token);
          return c.json({ ...r, redirectUrl: data.redirectUrl });
        } else {
          const r = await LocalAuth.login(
            data.email,
            data.password,
            sendVerificationEmail
          );
          setAuthCookies(c, r.token);
          return c.json({ ...r, redirectUrl: data.redirectUrl });
        }
      } catch (err) {
        throw new HTTPException(401, { message: "Invalid login: " + err });
      }
    }
  );

  /**
   * Request an email login code (OTP) for server-to-server use.
   * Counterpart to /user/login-with-code.
   */
  app.post(
    API_BASE_PATH + "/user/request-login-code",
    async (c) => {
      const { email } = await c.req.json<{ email?: string }>().catch(() => ({}) as any);
      if (email) await sendEmailLoginCode(email);
      return c.json({ ok: true });
    }
  );

  /**
   * Verify an email login code and return a JWT in the response body.
   * Designed for server-to-server use (e.g. connection onboarding from a robot).
   * Unlike /oauth/login/verify, this returns the token instead of setting a cookie.
   */
  app.post(
    API_BASE_PATH + "/user/login-with-code",
    async (c) => {
      const { email, code } = await c.req.json<{ email?: string; code?: string }>().catch(() => ({}) as any);
      try {
        const { userId } = await verifyEmailLoginCode(email ?? "", code ?? "");
        const session = await createJwtSessionForUserId(userId);
        return c.json({ token: session.token, expiresAt: session.expiresAt });
      } catch {
        return c.json({ ok: false, error: "invalid_code" }, 400);
      }
    }
  );

  /**
   * Logout endpoint - clears the auth cookies.
   * Public so it succeeds even with an already-expired token.
   */
  app.post(
    API_BASE_PATH + "/user/logout",
    describeRoute({
      tags: ["user"],
      summary: "Logout - clears auth cookies",
      responses: {
        200: { description: "Successful response" },
      },
    }),
    async (c) => {
      // Revoke the server-side session so the token cannot be reused after
      // logout. Public route: read the token directly from cookie/header.
      const authHeader = c.req.header("Authorization");
      const jwtToken =
        authHeader && authHeader.startsWith("Bearer ")
          ? authHeader.substring(7)
          : getCookie(c, JWT_COOKIE_NAME) || "";
      if (jwtToken) {
        await revokeSessionByToken(jwtToken);
        await deleteCachedToken(jwtToken);
      }
      clearAuthCookies(c);
      return c.json(RESPONSES.SUCCESS);
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
        // JSON-stringified object. Persisted on the newly created user as
        // `users.meta.customRegisterData` and forwarded to post-register actions.
        customRegisterData: v.optional(v.string()),
        // Key of a custom email template registered via
        // `emailTemplates.custom` in the server config. Falls back to the
        // default magic link template when missing.
        template: v.optional(v.string()),
        // Optional firstname/surname applied when a new user is created
        // (only used together with createUserIfMissing=true).
        firstname: v.optional(v.string()),
        surname: v.optional(v.string()),
      })
    ),
    async (c) => {
      const query = c.req.valid("query");
      const email = query.email;
      const createUserIfMissing = query.createUserIfMissing === "true";
      const invitationCode = query.invitationCode;
      const template = query.template;
      const firstname = query.firstname;
      const surname = query.surname;
      let customRegisterData: Record<string, any> | undefined;
      if (query.customRegisterData) {
        try {
          const parsed = JSON.parse(query.customRegisterData);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            customRegisterData = parsed;
          }
        } catch {
          throw new HTTPException(400, {
            message: "Invalid customRegisterData: must be JSON object",
          });
        }
      }
      if (!email) {
        throw new HTTPException(400, { message: "?email=... is required" });
      }
      try {
        console.log("createUserIfMissing", createUserIfMissing);
        await LocalAuth.sendMagicLink(
          email,
          undefined,
          createUserIfMissing,
          invitationCode,
          customRegisterData,
          template,
          firstname,
          surname
        );
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
   * Accept a tenant invitation from the link in the invitation email.
   *
   * This is the "one click = accepted" entry point and works for both new and
   * existing users:
   * - Existing users: the membership is confirmed immediately, a login session
   *   is established (auth cookies set) and the user is redirected into the app.
   * - Users without an account yet: they are redirected to the registration
   *   page with their email pre-filled; `LocalAuth.register` then auto-accepts
   *   the pending invitation once the account is created.
   *
   * Public by design: the caller is authenticated by possession of the signed,
   * expiring token that was mailed to the invitee's address (same trust model
   * as a magic login link).
   */
  app.get(
    API_BASE_PATH + "/user/accept-invitation",
    describeRoute({
      tags: ["user"],
      summary: "Accept a tenant invitation via the emailed link",
      responses: {
        302: {
          description: "Redirect into the app or to the registration page",
        },
      },
    }),
    validator("query", v.object({ token: v.string() })),
    async (c) => {
      const { token } = c.req.valid("query");
      const baseUrl = _GLOBAL_SERVER_CONFIG.baseUrl;
      try {
        const result = await acceptInvitationByToken(token);

        if (result.status === "needs_registration") {
          // No account yet -> send the user to registration with the email
          // pre-filled. Registration auto-accepts the pending invitation.
          const url =
            `${baseUrl}${_GLOBAL_SERVER_CONFIG.loginUrl}` +
            `?register=true&email=${encodeURIComponent(result.email)}` +
            `&hideInvitationCode=true`;
          return c.redirect(url);
        }

        // Existing user -> log them in and drop them into the app as a
        // confirmed member. The landing page defaults to "/" and can be
        // overridden per app via `invitationAcceptRedirectUrl` in the config.
        const session = await createJwtSessionForUserId(result.userId);
        setAuthCookies(c, session.token);
        return c.redirect(
          `${baseUrl}${_GLOBAL_SERVER_CONFIG.invitationAcceptRedirectUrl}`
        );
      } catch (err) {
        log.error("Error accepting invitation via link: " + err);
        // Do not leak details – forward to the login page with a hint so the
        // SPA can show a friendly "invalid or expired invitation" message.
        return c.redirect(
          `${baseUrl}${_GLOBAL_SERVER_CONFIG.loginUrl}?invitationError=invalid`
        );
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
        setAuthCookies(c, r.token);
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
   * Start a social login: build the provider's authorize URL and pin `state`
   * plus the PKCE verifier (and the post-login redirect target) in a
   * short-lived HttpOnly cookie. See ../../lib/auth/oauth2.
   */
  app.get(
    API_BASE_PATH + "/user/auth/:provider",
    describeRoute({
      tags: ["user"],
      summary: "Redirect to the provider's sign-in page",
      responses: {
        302: {
          description: "Redirect to the provider (or back to the login page)",
        },
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
      const provider = c.req.valid("param").provider;

      if (!isOAuthProvider(provider) || !isOAuthProviderActive(provider)) {
        // Not configured on this instance: no button should have been offered,
        // so this is a stale page or a hand-crafted URL.
        return c.redirect(oauthLoginError("oauth_unavailable"));
      }

      const state = createOAuthRandomToken();
      const verifier = createOAuthRandomToken();
      const redirect = sanitizeOAuthRedirect(
        c.req.query("redirectUrl"),
        `${_GLOBAL_SERVER_CONFIG.oauthCallbackUrl}?provider=${provider}`
      );

      setCookie(
        c,
        OAUTH_LOGIN_TX_COOKIE,
        encodeOAuthTransaction({ state, verifier, redirect }),
        {
          httpOnly: true,
          secure: isSecureContext(),
          // Lax, not Strict: the user comes back through a top-level
          // navigation started on the provider's domain.
          sameSite: "Lax",
          path: "/",
          maxAge: OAUTH_LOGIN_TX_TTL_SECONDS,
        }
      );

      return c.redirect(
        OAuthAuth.getAuthUrl(provider, {
          state,
          codeChallenge: createOAuthCodeChallenge(verifier),
        })
      );
    }
  );

  /**
   * Finish a social login. Sets the same auth cookies as every other login
   * flow and redirects into the app — the session token never travels through
   * the URL.
   */
  app.get(
    API_BASE_PATH + "/user/auth/:provider/callback",
    describeRoute({
      tags: ["user"],
      summary: "Handle the provider's OAuth callback",
      responses: {
        302: {
          description: "Redirect into the app (or back to the login page)",
        },
      },
    }),
    validator(
      "query",
      v.object({
        code: v.optional(v.string()),
        state: v.optional(v.string()),
        error: v.optional(v.string()),
        error_description: v.optional(v.string()),
      })
    ),
    validator(
      "param",
      v.object({
        provider: v.string(),
      })
    ),
    async (c) => {
      const provider = c.req.valid("param").provider;
      const transaction = decodeOAuthTransaction(
        getCookie(c, OAUTH_LOGIN_TX_COOKIE)
      );

      // One-shot: the transaction must not be replayable, not even after a
      // failure further down.
      deleteCookie(c, OAUTH_LOGIN_TX_COOKIE, {
        path: "/",
        secure: isSecureContext(),
        sameSite: "Lax",
      });

      if (!isOAuthProvider(provider) || !isOAuthProviderActive(provider)) {
        return c.redirect(oauthLoginError("oauth_unavailable"));
      }

      // The user declined consent, or the provider rejected the request.
      const providerError = c.req.query("error");
      if (providerError) {
        log.info(
          `${provider} login aborted: ${providerError} ${
            c.req.query("error_description") ?? ""
          }`
        );
        return c.redirect(
          oauthLoginError(
            providerError === "access_denied"
              ? "oauth_cancelled"
              : "oauth_failed"
          )
        );
      }

      const code = c.req.query("code");
      const state = c.req.query("state");

      if (
        !transaction ||
        !code ||
        !state ||
        !isSameOAuthState(transaction.state, state)
      ) {
        // Missing/expired cookie or a state mismatch (CSRF, or the login was
        // started in another browser).
        log.info(`${provider} login callback with invalid state`);
        return c.redirect(oauthLoginError("oauth_failed"));
      }

      try {
        const result = await OAuthAuth.handleCallback(
          provider,
          code,
          transaction.verifier
        );

        setAuthCookies(c, result.token);

        return c.redirect(transaction.redirect);
      } catch (err) {
        log.error(`${provider} login failed: ${err}`);
        return c.redirect(oauthLoginError("oauth_failed"));
      }
    }
  );
}
