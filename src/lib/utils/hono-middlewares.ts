import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import jwtlib from "jsonwebtoken";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { generateTemporaryJwtFromToken } from "../auth/token-auth";
import { verifyHankoToken } from "../auth/hanko";
import { getCachedToken, setCachedToken } from "./redis-cache";
import { isSessionValid } from "../auth/sessions";

const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || "";

// Hono can´t handle Auth0 JWT tokens
// https://github.com/honojs/hono/issues/672

/**
 * Verify a JWT and enforce server-side session validity.
 *
 * The signature check is cached (keyed by token) to keep the RSA verify off the
 * hot path. Independently, interactive user-login tokens carry a `sid` claim
 * that is validated against the session store on EVERY request (cache hit or
 * not) — this is what makes logout / password-reset revocation effective.
 *
 * Exempt from the session check:
 *  - service tokens (`apiToken` / `type: "connection"`) — stateless by design
 *  - non-local auth (auth0 issues and manages its own tokens; hanko is handled
 *    in a separate branch before this function)
 */
const getTokenFromJwt = async (token: string) => {
  let email: string;
  let sub: string;
  let scopes: string[] | undefined;
  let sid: string | undefined;
  let service: boolean;
  let type: string | undefined;
  let tenantId: string | undefined;

  const cached = await getCachedToken(token);
  if (cached) {
    email = cached.usersEmail;
    sub = cached.usersId;
    scopes = cached.scopes;
    sid = cached.sid;
    service = cached.service ?? false;
    type = cached.type;
    tenantId = cached.tenantId;
  } else {
    const decoded = jwtlib.verify(token, JWT_PUBLIC_KEY, {
      algorithms:
        _GLOBAL_SERVER_CONFIG.authType === "auth0" ? ["RS256"] : undefined,
    });
    if (typeof decoded !== "object" || !decoded.email || !decoded.sub) {
      throw new Error("Invalid token");
    }
    const claims = decoded as any;
    const isOauth = claims.oauth === true;
    email = decoded.email;
    sub = decoded.sub;
    // OAuth access tokens carry a space-separated `scope` string (OAuth/OIDC
    // convention); framework/api tokens carry a `scopes` array.
    scopes =
      isOauth && typeof claims.scope === "string"
        ? claims.scope.split(" ").filter(Boolean)
        : claims.scopes;
    sid = claims.sid;
    // OAuth access tokens are stateless like service tokens → no `sid` session
    // check (they are revocable via their refresh token instead).
    service =
      claims.apiToken === true || claims.type === "connection" || isOauth;
    type = claims.type;
    tenantId = claims.tenantId;

    await setCachedToken(token, {
      usersEmail: email,
      usersId: sub,
      scopes,
      sid,
      service,
      type,
      tenantId,
    });
  }

  // Stateful session enforcement for interactive logins on local auth.
  if (_GLOBAL_SERVER_CONFIG.authType === "local" && !service) {
    if (!sid || !(await isSessionValid(sid))) {
      throw new Error("Session is no longer valid");
    }
  }

  return { email, sub, scopes, sid, type, tenantId };
};

/**
 * HONO Middleware to add scopes to the context
 */
export function addScopesToContext(c: Context, scopes?: string[]) {
  c.set("scopes", scopes ?? ["all"]);
}

/**
 * HONO Middleware to check if the user has permission for the given path and method
 */
export async function checkUserPermission(c: Context, next: Function) {
  // HACK!!!
  await next();
  // const userId = c.get("usersId");
  // const method = c.req.method;
  // const path = c.req.path;
  // const userCanAccess = await hasPermission(userId, method, path);
  // if (!userCanAccess) {
  //   return c.text("Not permitted", 403);
  // }
  // await next();
}

/**
 * Is this request a WebSocket handshake?
 *
 * `Upgrade` is a forbidden header name in browsers: page JavaScript cannot set
 * it on a fetch/XHR, only the WebSocket constructor produces it. That is what
 * makes it usable as the gate for accepting a session token from the query
 * string — a normal API call cannot pretend to be an upgrade.
 */
const isWebSocketUpgrade = (c: Context): boolean =>
  (c.req.header("Upgrade") ?? "").toLowerCase() === "websocket";

/**
 * Does this string have the shape of a JWT?
 *
 * Used to tell the two kinds of credential in `?token=` apart: a session JWT has
 * three base64url segments, an API token is a `nanoid` and never contains a dot.
 * The distinction has to be made *before* either path runs — resolving an API
 * token hits the database, and verifying a JWT needs the value to be one — so
 * the shape is checked rather than the outcome.
 */
const looksLikeJwt = (value: string): boolean =>
  value.split(".").length === 3;

/**
 * HONO Middleware to check the JWT token
 */
export const checkToken = async (c: Context) => {
  if (_GLOBAL_SERVER_CONFIG.authType === "hanko") {
    const { usersEmail, usersId } = await verifyHankoToken(c);
    return {
      usersEmail: usersEmail,
      usersId: usersId,
      scopes: ["all"], // Hanko tokens always have full access
      sessionId: undefined as string | undefined,
      tokenType: undefined as string | undefined,
      tokenTenantId: undefined as string | undefined,
    };
  } else {
    // get existing params
    const token = c.req.query("token");
    const authHeader = c.req.header("Authorization");
    const xApiKey = c.req.header("X-API-KEY");

    let jwtToken = "";

    if (token && isWebSocketUpgrade(c) && looksLikeJwt(token)) {
      // A browser cannot set headers on a WebSocket handshake — `new WebSocket()`
      // takes a URL and nothing else — so a client that authenticates with a
      // bearer token (an SPA embedded in Microsoft Teams, where the session
      // cookie is cross-site and never sent) has no way to open a socket other
      // than putting its session token in the query string.
      //
      // Narrow on purpose, in two directions. Only on an upgrade request, so
      // this cannot become a general "session in the URL" mode — URLs end up in
      // proxy logs, browser history and referrers, and a plain GET is far easier
      // to leak than a handshake. And only for something shaped like a JWT, so
      // an API token in `?token=` keeps being resolved the way it always was,
      // sockets included.
      jwtToken = token;
    } else if (token || xApiKey) {
      const tokenToUse: string = token || xApiKey || "";
      // try to generate a JWT token from the token string
      const temporaryJwt = await generateTemporaryJwtFromToken(tokenToUse);
      jwtToken = temporaryJwt.token;
    } else if (authHeader && authHeader.startsWith("Bearer ")) {
      jwtToken = authHeader.substring(7);
    } else {
      jwtToken = getCookie(c, "jwt") || "";
    }

    if (!jwtToken || jwtToken === "") {
      throw new Error("Invalid token");
    }

    const decoded = await getTokenFromJwt(jwtToken);
    // Extract scopes from JWT, default to ["all"] if not present (normal session)
    const scopes = decoded.scopes || ["all"];
    return {
      usersEmail: decoded.email ?? "",
      usersId: decoded.sub ?? "",
      scopes: Array.isArray(scopes) ? scopes : ["all"],
      sessionId: decoded.sid,
      tokenType: decoded.type,
      tokenTenantId: decoded.tenantId,
    };
  }
};

/**
 * HONO Middleware to set the usersEmail, usersId and usersRoles in the context
 */
export const authAndSetUsersInfo = async (c: Context, next: Function) => {
  try {
    const { usersEmail, usersId, scopes, sessionId, tokenType, tokenTenantId } =
      await checkToken(c);
    c.set("usersEmail", usersEmail);
    c.set("usersId", usersId);
    c.set("sessionId", sessionId);
    c.set("tokenType", tokenType);
    c.set("tokenTenantId", tokenTenantId);
    addScopesToContext(c, scopes);
  } catch (error) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  await next();
};

/**
 * HONO Middleware to check the JWT token and redirect to login if not valid
 */
export const authOrRedirectToLogin = async (c: Context, next: Function) => {
  try {
    await checkToken(c);
    addScopesToContext(c, ["all"]);
  } catch (error) {
    return c.redirect(
      _GLOBAL_SERVER_CONFIG.loginUrl +
        "?redirectUrl=" +
        encodeURIComponent(c.req.url)
    );
  }
  await next();
};

/**
 * HONO Middleware to check the JWT token and redirect to login if not valid
 * and set the usersEmail, usersId and usersRoles in the context
 */
export const authAndSetUsersInfoOrRedirectToLogin = async (
  c: Context,
  next: Function
) => {
  try {
    const { usersEmail, usersId, scopes, sessionId } = await checkToken(c);
    c.set("usersEmail", usersEmail);
    c.set("usersId", usersId);
    c.set("sessionId", sessionId);
    addScopesToContext(c, scopes);
  } catch (error) {
    return c.redirect(
      _GLOBAL_SERVER_CONFIG.loginUrl +
        "?redirectUrl=" +
        encodeURIComponent(c.req.url)
    );
  }
  await next();
};
