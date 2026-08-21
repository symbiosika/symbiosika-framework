/**
 * Authentication for framework-mounted MCP endpoints.
 *
 * Because the MCP server lives in the same process as the authorization
 * server, no introspection round-trip and no shared secret are needed — the
 * credentials are validated with the framework's own key material:
 *
 *   1. **OAuth2 access tokens** (`Authorization: Bearer <jwt>` with
 *      `oauth: true`) — verified locally, then checked against this
 *      endpoint's audience (RFC 8707): a token minted for another resource
 *      is rejected. Carries the tenant chosen at sign-in.
 *   2. **Framework API tokens** (`X-API-KEY: …`, or a non-JWT value in the
 *      Bearer slot for hosts that only expose one token field) — exchanged
 *      for a short-lived JWT exactly like the auth middleware does. Carries
 *      the tenant the token was minted for.
 *   3. **Session JWTs** (a normal login token in the Bearer slot) — accepted
 *      for testing and first-party callers; the server-side session (`sid`)
 *      is enforced like everywhere else.
 *
 * Failures return `null` and log the reason — the caller answers 401 with a
 * `WWW-Authenticate` pointer to the protected-resource metadata.
 */
import jwtlib from "jsonwebtoken";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { generateTemporaryJwtFromToken } from "../auth/token-auth";
import { isSessionValid } from "../auth/sessions";
import type { McpTokenKind } from "./types";

const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || "";

/** The validated credential, before it is turned into a request context. */
export type McpAuthInfo = {
  usersId: string;
  usersEmail?: string;
  tenantId?: string;
  scopes: string[];
  tokenKind: McpTokenKind;
  /** The credential exactly as presented (forwarded by `fetchApi`). */
  token: string;
  /**
   * Which header `fetchApi` must forward the credential on. Raw API tokens
   * always go on `x-api-key` (the framework's Bearer slot only accepts
   * JWTs), even when the client presented them as Bearer.
   */
  header: "authorization" | "x-api-key";
};

/** JWTs have three base64url segments; framework API tokens are nanoids. */
const looksLikeJwt = (value: string): boolean =>
  value.split(".").length === 3;

/**
 * Canonicalize a URL for audience comparison (RFC 8707): lowercase scheme and
 * host, drop default ports and trailing slashes.
 */
const canonical = (u: string): string => {
  try {
    const url = new URL(u ?? "");
    const port =
      url.port &&
      !(
        (url.protocol === "https:" && url.port === "443") ||
        (url.protocol === "http:" && url.port === "80")
      )
        ? `:${url.port}`
        : "";
    return `${url.protocol}//${url.hostname.toLowerCase()}${port}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return (u ?? "").replace(/\/$/, "");
  }
};

const deny = (reason: string): null => {
  console.warn(`[mcp] token rejected: ${reason}`);
  return null;
};

const parseScopes = (claims: any): string[] => {
  if (typeof claims.scope === "string") {
    return claims.scope.split(" ").filter(Boolean);
  }
  if (Array.isArray(claims.scopes)) {
    return claims.scopes;
  }
  return ["all"];
};

/** Validate a JWT presented as Bearer (OAuth access token or session JWT). */
const authenticateJwt = async (
  token: string,
  resourceUrl: string
): Promise<McpAuthInfo | null> => {
  let claims: jwtlib.JwtPayload;
  try {
    const decoded = jwtlib.verify(token, JWT_PUBLIC_KEY, {
      algorithms:
        _GLOBAL_SERVER_CONFIG.authType === "auth0" ? ["RS256"] : undefined,
    });
    if (typeof decoded !== "object" || !decoded.sub) {
      return deny("JWT carries no subject");
    }
    claims = decoded;
  } catch (error) {
    return deny(`invalid JWT: ${(error as Error).message}`);
  }

  if (claims.oauth === true) {
    // OAuth access token → the audience must be THIS endpoint. Accepted:
    // the resource URL itself, the server origin, or the issuer (legacy
    // tokens minted without a resource indicator).
    const issuer =
      _GLOBAL_SERVER_CONFIG.oauth2?.issuer || _GLOBAL_SERVER_CONFIG.baseUrl;
    const accepted = [resourceUrl, _GLOBAL_SERVER_CONFIG.baseUrl, issuer].map(
      canonical
    );
    const audList = (Array.isArray(claims.aud) ? claims.aud : [claims.aud])
      .filter(Boolean)
      .map((a) => canonical(String(a)));
    if (!audList.some((a) => accepted.includes(a))) {
      return deny(
        `audience mismatch: aud=${JSON.stringify(claims.aud)}, expected one of ${JSON.stringify(accepted)}`
      );
    }
    return {
      usersId: claims.sub!,
      usersEmail: claims.email,
      tenantId: claims.tenant ?? undefined,
      scopes: parseScopes(claims),
      tokenKind: "oauth",
      token,
      header: "authorization",
    };
  }

  // Session / API-token-derived JWT. Interactive login tokens carry a `sid`
  // that must still map to a live server-side session (logout revocation).
  const isService = claims.apiToken === true || claims.type === "connection";
  if (_GLOBAL_SERVER_CONFIG.authType === "local" && !isService) {
    if (!claims.sid || !(await isSessionValid(claims.sid))) {
      return deny("session is no longer valid");
    }
  }
  return {
    usersId: claims.sub!,
    usersEmail: claims.email,
    tenantId: claims.tenantId ?? undefined,
    scopes: parseScopes(claims),
    tokenKind: isService ? "api-token" : "session",
    token,
    header: "authorization",
  };
};

/** Validate a framework API token by exchanging it for a short-lived JWT. */
const authenticateApiToken = async (
  token: string
): Promise<McpAuthInfo | null> => {
  try {
    const { token: jwt } = await generateTemporaryJwtFromToken(token);
    const claims = jwtlib.verify(jwt, JWT_PUBLIC_KEY) as jwtlib.JwtPayload;
    if (!claims.sub) return deny("API token resolved to no subject");
    return {
      usersId: claims.sub,
      usersEmail: claims.email,
      tenantId: claims.tenantId ?? undefined,
      scopes: parseScopes(claims),
      tokenKind: "api-token",
      token,
      header: "x-api-key",
    };
  } catch (error) {
    return deny(`invalid API token: ${(error as Error).message}`);
  }
};

/**
 * Validate the credential on an incoming MCP request. Returns `null` when the
 * request carries no valid credential.
 */
export const authenticateMcpRequest = async (
  req: Request,
  resourceUrl: string
): Promise<McpAuthInfo | null> => {
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) return authenticateApiToken(apiKey);

  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  // Bearer-only hosts put API tokens in the Bearer slot; the shape decides.
  if (!looksLikeJwt(token)) return authenticateApiToken(token);
  return authenticateJwt(token, resourceUrl);
};
