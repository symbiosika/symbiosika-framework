/**
 * OAuth2 / OIDC Authorization Server — route registration.
 *
 * Public flow + discovery are mounted at the domain root (spec requirement for
 * `.well-known/*`). Tenant-admin client management is mounted under the API
 * base path and protected by `authAndSetUsersInfo` + `isTenantAdmin`.
 *
 * See docs/framework/16_OAuth2_OIDC_Provider.md
 */
import type { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import type { SFContextVariables } from "../../types";
import { getDb } from "../db/db-connection";
import { users, tenantMembers, tenants } from "../db/db-schema";
import { availableScopes } from "../auth/available-scopes";
import {
  authAndSetUsersInfo,
  checkToken,
} from "../utils/hono-middlewares";
import { isTenantAdmin } from "../../routes/tenant";
import { setAuthCookies } from "../auth/auth-cookies";
import { createJwtSessionForUserId, LocalAuth } from "../auth";
import { sendEmailLoginCode, verifyEmailLoginCode } from "../auth/email-otp";
import {
  getOAuthClient,
  verifyClientSecret,
  createOAuthClient,
  listClientsForTenant,
  rotateClientSecret,
  updateOAuthClient,
  deleteOAuthClient,
  type OAuthClientRow,
} from "./clients";
import { issueAuthCode, consumeAuthCode } from "./codes";
import {
  generateAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  introspectAccessToken,
} from "./tokens";
import { generateIdToken, OIDC_SCOPES, type OidcUser } from "./oidc";
import { hasConsentForScopes, saveConsent } from "./consents";
import { verifyPkce } from "./pkce";
import {
  buildAuthServerMetadata,
  buildOpenIdConfiguration,
  buildJwks,
} from "./metadata";

type App = Hono<{ Variables: SFContextVariables }>;

const views = () => _GLOBAL_SERVER_CONFIG.oauth2.views;
const oauthCfg = () => _GLOBAL_SERVER_CONFIG.oauth2;

const parseScopes = (scope: string | undefined): string[] =>
  (scope ?? "").split(/\s+/).filter(Boolean);

const isScopeAllowed = (scope: string, client: OAuthClientRow): boolean =>
  (OIDC_SCOPES as readonly string[]).includes(scope) ||
  (client.scopes as string[]).includes(scope);

const appendParams = (
  uri: string,
  params: Record<string, string | undefined | null>
): string => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) u.searchParams.set(k, v);
  }
  return u.toString();
};

const wantsJson = (c: Context): boolean =>
  (c.req.header("accept") ?? "").includes("application/json");

/** Soft session check: returns the logged-in userId or null. */
const currentUserId = async (c: Context): Promise<string | null> => {
  try {
    const { usersId } = await checkToken(c);
    return usersId || null;
  } catch {
    return null;
  }
};

const loadOidcUser = async (userId: string): Promise<OidcUser | null> => {
  const rows = await getDb()
    .select({
      id: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      firstname: users.firstname,
      surname: users.surname,
    })
    .from(users)
    .where(eq(users.id, userId));
  return rows[0] ?? null;
};

const tenantMembershipsOf = async (userId: string) => {
  return getDb()
    .select({ id: tenants.id, name: tenants.name })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
    .where(eq(tenantMembers.userId, userId));
};

/** Issue an authorization code and return the client redirect (or JSON). */
const finishAuthorize = async (
  c: Context,
  args: {
    client: OAuthClientRow;
    userId: string;
    tenantId: string | null;
    redirectUri: string;
    scopes: string[];
    codeChallenge: string;
    codeChallengeMethod: string;
    nonce: string | null;
    state?: string;
  }
) => {
  const code = await issueAuthCode({
    clientId: args.client.clientId,
    userId: args.userId,
    tenantId: args.tenantId,
    redirectUri: args.redirectUri,
    scopes: args.scopes,
    codeChallenge: args.codeChallenge,
    codeChallengeMethod: args.codeChallengeMethod,
    nonce: args.nonce,
  });
  const redirect = appendParams(args.redirectUri, {
    code,
    state: args.state,
  });
  if (wantsJson(c)) {
    return c.json({ step: "redirect", redirect });
  }
  return c.redirect(redirect);
};

/**
 * Register all OAuth2/OIDC routes. No-op unless `oauth2.enabled` is true.
 */
export function defineOAuth2Routes(app: App, API_BASE_PATH: string) {
  if (!oauthCfg().enabled) {
    return;
  }

  // ---- Discovery (domain root) ------------------------------------------
  app.get("/.well-known/openid-configuration", (c) =>
    c.json(buildOpenIdConfiguration())
  );
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(buildAuthServerMetadata())
  );
  app.get("/.well-known/jwks.json", async (c) => c.json(await buildJwks()));

  // ---- Authorize --------------------------------------------------------
  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const authorizeQuery = new URL(c.req.url).search.slice(1);

    const client = await getOAuthClient(q.client_id ?? "");
    if (!client) {
      return c.json({ error: "invalid_client" }, 400);
    }
    const redirectUri = q.redirect_uri ?? "";
    if (!(client.redirectUris as string[]).includes(redirectUri)) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }

    // From here redirect_uri is trusted → recoverable errors go via redirect.
    const redirErr = (error: string) => {
      if (wantsJson(c)) return c.json({ step: "error", error }, 400);
      return c.redirect(appendParams(redirectUri, { error, state: q.state }));
    };

    if (q.response_type !== "code") return redirErr("unsupported_response_type");
    const method = q.code_challenge_method ?? "S256";
    if (!q.code_challenge || method !== "S256")
      return redirErr("invalid_request");

    const requested = parseScopes(q.scope);
    if (requested.some((s) => !isScopeAllowed(s, client)))
      return redirErr("invalid_scope");

    const userId = await currentUserId(c);
    if (!userId) {
      if (wantsJson(c)) return c.json({ step: "login" });
      return c.html(views().login({
        appName: _GLOBAL_SERVER_CONFIG.appName,
        logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
        authorizeQuery,
      }));
    }

    // Tenant resolution.
    const memberships = await tenantMembershipsOf(userId);
    let tenantId: string | null = null;
    if (q.tenant_id && memberships.some((m) => m.id === q.tenant_id)) {
      tenantId = q.tenant_id;
    } else if (memberships.length === 1) {
      tenantId = memberships[0].id;
    } else if (memberships.length === 0) {
      return redirErr("access_denied");
    } else {
      if (wantsJson(c))
        return c.json({ step: "tenant", tenants: memberships });
      return c.html(views().tenantSelect({
        appName: _GLOBAL_SERVER_CONFIG.appName,
        logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
        authorizeQuery,
        tenants: memberships,
      }));
    }

    // Consent.
    if (
      oauthCfg().requireConsentScreen &&
      !(await hasConsentForScopes(userId, client.clientId, requested))
    ) {
      if (wantsJson(c))
        return c.json({
          step: "consent",
          client_name: client.clientName,
          scopes: requested,
        });
      return c.html(views().consent({
        appName: _GLOBAL_SERVER_CONFIG.appName,
        logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
        authorizeQuery,
        clientName: client.clientName,
        scopes: requested,
      }));
    }

    return finishAuthorize(c, {
      client,
      userId,
      tenantId,
      redirectUri,
      scopes: requested,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: method,
      nonce: q.nonce ?? null,
      state: q.state,
    });
  });

  // ---- Consent decision -------------------------------------------------
  app.post("/oauth/consent", async (c) => {
    const body = await c.req.parseBody().catch(() => ({}) as any);
    const authorizeQuery =
      (body.authorize_query as string) ?? new URL(c.req.url).search.slice(1);
    const decision = body.decision as string;
    const params = new URLSearchParams(authorizeQuery);

    const client = await getOAuthClient(params.get("client_id") ?? "");
    if (!client) return c.json({ error: "invalid_client" }, 400);
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!(client.redirectUris as string[]).includes(redirectUri))
      return c.json({ error: "invalid_redirect_uri" }, 400);

    const state = params.get("state") ?? undefined;
    if (decision !== "approve") {
      const redirect = appendParams(redirectUri, {
        error: "access_denied",
        state,
      });
      return wantsJson(c) ? c.json({ redirect }) : c.redirect(redirect);
    }

    const userId = await currentUserId(c);
    if (!userId) return c.json({ error: "login_required" }, 401);

    const requested = parseScopes(params.get("scope") ?? "");
    if (requested.some((s) => !isScopeAllowed(s, client)))
      return c.json({ error: "invalid_scope" }, 400);

    // Tenant.
    const memberships = await tenantMembershipsOf(userId);
    const wanted = params.get("tenant_id");
    let tenantId: string | null = null;
    if (wanted && memberships.some((m) => m.id === wanted)) tenantId = wanted;
    else if (memberships.length === 1) tenantId = memberships[0].id;

    await saveConsent(userId, client.clientId, requested);

    return finishAuthorize(c, {
      client,
      userId,
      tenantId,
      redirectUri,
      scopes: requested,
      codeChallenge: params.get("code_challenge") ?? "",
      codeChallengeMethod: params.get("code_challenge_method") ?? "S256",
      nonce: params.get("nonce"),
      state,
    });
  });

  // ---- Passwordless email-code login (JSON) -----------------------------
  app.post("/oauth/login/start", async (c) => {
    const { email } = await c.req
      .json<{ email?: string }>()
      .catch(() => ({}) as { email?: string });
    if (email) await sendEmailLoginCode(email);
    return c.json({ ok: true }); // never reveal whether the account exists
  });

  app.post("/oauth/login/verify", async (c) => {
    const { email, code } = await c.req
      .json<{ email?: string; code?: string }>()
      .catch(() => ({}) as any);
    try {
      const { userId } = await verifyEmailLoginCode(email ?? "", code ?? "");
      const session = await createJwtSessionForUserId(userId);
      setAuthCookies(c, session.token);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, error: "invalid_code" }, 400);
    }
  });

  app.post("/oauth/login/password", async (c) => {
    const { email, password } = await c.req
      .json<{ email?: string; password?: string }>()
      .catch(() => ({}) as any);
    try {
      const r = await LocalAuth.login(email ?? "", password ?? "", false);
      setAuthCookies(c, r.token);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, error: "invalid_credentials" }, 400);
    }
  });

  // ---- Token ------------------------------------------------------------
  app.post("/oauth/token", async (c) => {
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<
      string,
      string
    >;

    // Client authentication (Basic header or body).
    let clientId = body.client_id;
    let clientSecret: string | undefined = body.client_secret;
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        clientId = clientId || decoded.slice(0, idx);
        clientSecret = clientSecret ?? decoded.slice(idx + 1);
      }
    }

    const client = await getOAuthClient(clientId ?? "");
    if (!client) return c.json({ error: "invalid_client" }, 401);
    if (client.clientType === "confidential" && !verifyClientSecret(client, clientSecret)) {
      return c.json({ error: "invalid_client" }, 401);
    }

    const grantType = body.grant_type;

    try {
      if (grantType === "authorization_code") {
        const payload = await consumeAuthCode(
          body.code ?? "",
          client.clientId,
          body.redirect_uri ?? ""
        );
        if (
          !verifyPkce(
            body.code_verifier ?? "",
            payload.codeChallenge,
            payload.codeChallengeMethod
          )
        ) {
          return c.json({ error: "invalid_grant" }, 400);
        }
        return c.json(
          await buildTokenResponse({
            clientId: client.clientId,
            userId: payload.userId,
            tenantId: payload.tenantId,
            scopes: payload.scopes,
            nonce: payload.nonce,
          })
        );
      }

      if (grantType === "refresh_token") {
        const rotated = await rotateRefreshToken(
          body.refresh_token ?? "",
          client.clientId
        );
        return c.json(
          await buildTokenResponse({
            clientId: client.clientId,
            userId: rotated.userId,
            tenantId: rotated.tenantId,
            scopes: rotated.scopes,
            nonce: null,
            existingRefreshToken: rotated.refreshToken,
          })
        );
      }

      return c.json({ error: "unsupported_grant_type" }, 400);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "invalid_grant", error_description: message }, 400);
    }
  });

  // ---- Revoke (RFC 7009) ------------------------------------------------
  app.post("/oauth/revoke", async (c) => {
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<
      string,
      string
    >;
    if (body.token) {
      await revokeRefreshToken(body.token);
    }
    return c.json({ ok: true }); // always 200 per spec
  });

  // ---- Introspect (RFC 7662) --------------------------------------------
  app.post("/oauth/introspect", async (c) => {
    const secret = oauthCfg().introspectionSecret;
    if (secret) {
      const auth = c.req.header("authorization") ?? "";
      if (auth !== `Bearer ${secret}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<
      string,
      string
    >;
    const token = body.token ?? "";
    if (!token) return c.json({ active: false });
    return c.json(introspectAccessToken(token));
  });

  // ---- UserInfo (OIDC) --------------------------------------------------
  app.get("/oauth/userinfo", authAndSetUsersInfo, async (c) => {
    const userId = c.get("usersId");
    const scopes = c.get("scopes") ?? [];
    const user = await loadOidcUser(userId);
    if (!user) return c.json({ error: "invalid_token" }, 401);
    const claims: Record<string, unknown> = { sub: user.id };
    if (scopes.includes("email")) {
      claims.email = user.email;
      claims.email_verified = user.emailVerified ?? false;
    }
    if (scopes.includes("profile")) {
      const name = `${user.firstname ?? ""} ${user.surname ?? ""}`.trim();
      if (name) claims.name = name;
      if (user.firstname) claims.given_name = user.firstname;
      if (user.surname) claims.family_name = user.surname;
    }
    return c.json(claims);
  });

  // ---- Tenant-admin client management (protected) -----------------------
  const clientsBase = API_BASE_PATH + "/tenant/:tenantId/oauth/clients";

  app.post(clientsBase, authAndSetUsersInfo, isTenantAdmin, async (c) => {
    const tenantId = c.req.param("tenantId")!;
    const body = await c.req.json<{
      clientName: string;
      redirectUris: string[];
      scopes?: string[];
      clientType?: "public" | "confidential";
    }>();
    try {
      const created = await createOAuthClient({
        tenantId,
        clientName: body.clientName,
        redirectUris: body.redirectUris,
        scopes: body.scopes ?? [],
        clientType: body.clientType,
        createdBy: c.get("usersId"),
      });
      return c.json(created);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get(clientsBase, authAndSetUsersInfo, isTenantAdmin, async (c) =>
    c.json({ clients: await listClientsForTenant(c.req.param("tenantId")!) })
  );

  app.post(
    clientsBase + "/:id/rotate-secret",
    authAndSetUsersInfo,
    isTenantAdmin,
    async (c) => {
      try {
        const r = await rotateClientSecret(
          c.req.param("tenantId")!,
          c.req.param("id")!
        );
        return c.json(r);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
  );

  app.patch(
    clientsBase + "/:id",
    authAndSetUsersInfo,
    isTenantAdmin,
    async (c) => {
      const patch = await c.req.json<{
        clientName?: string;
        redirectUris?: string[];
        scopes?: string[];
        disabled?: boolean;
      }>();
      try {
        await updateOAuthClient(
          c.req.param("tenantId")!,
          c.req.param("id")!,
          patch
        );
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
  );

  app.delete(
    clientsBase + "/:id",
    authAndSetUsersInfo,
    isTenantAdmin,
    async (c) => {
      try {
        await deleteOAuthClient(c.req.param("tenantId")!, c.req.param("id")!);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
  );
}

/**
 * Build the OAuth token response (access + refresh + optional id_token).
 * On refresh, the rotated refresh token is passed in; on code exchange a new
 * refresh-token family is created.
 */
const buildTokenResponse = async (args: {
  clientId: string;
  userId: string;
  tenantId: string | null;
  scopes: string[];
  nonce: string | null;
  existingRefreshToken?: string;
}) => {
  const user = await loadOidcUser(args.userId);
  const { token: accessToken, expiresIn } = generateAccessToken({
    userId: args.userId,
    email: user?.email,
    tenantId: args.tenantId,
    clientId: args.clientId,
    scopes: args.scopes,
  });

  const refreshToken =
    args.existingRefreshToken ??
    (
      await issueRefreshToken({
        clientId: args.clientId,
        userId: args.userId,
        tenantId: args.tenantId,
        scopes: args.scopes,
      })
    ).token;

  const response: Record<string, unknown> = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: args.scopes.join(" "),
  };

  if (args.scopes.includes("openid") && user) {
    response.id_token = await generateIdToken({
      user,
      clientId: args.clientId,
      scopes: args.scopes,
      nonce: args.nonce,
    });
  }

  return response;
};
