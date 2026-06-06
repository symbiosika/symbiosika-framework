/**
 * OAuth2 token issuance.
 *
 * - Access token: RS256 JWT signed with the framework key. Carries `oauth:true`
 *   (so the auth middleware skips the session/`sid` check), plus `client_id`,
 *   `tenant` and `scope`. Short-lived.
 * - Refresh token: opaque random string, stored only as a hash, with rotation
 *   and reuse-detection (re-using a rotated token revokes the whole family).
 */
import jwt from "jsonwebtoken";
import * as crypto from "crypto";
import { nanoid } from "nanoid";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { oauthRefreshTokens } from "../db/db-schema";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { JWT_HS256_SECRET } from "./keys";
import { sha256hex, isExpired } from "./util";

const issuer = () =>
  _GLOBAL_SERVER_CONFIG.oauth2?.issuer || _GLOBAL_SERVER_CONFIG.baseUrl;

export type IntrospectResponse =
  | { active: false }
  | {
      active: true;
      sub: string;
      scope: string;
      client_id: string;
      tenant: string | null;
      aud: string | string[];
      exp: number;
      iat: number;
      iss: string;
    };

/**
 * Verify an access token and return its claims in RFC 7662 introspection shape.
 * Signature + expiry are checked; audience is NOT re-verified (the caller is
 * already authorised by the introspection secret if one is configured).
 */
export const introspectAccessToken = (token: string): IntrospectResponse => {
  try {
    const decoded = jwt.verify(token, JWT_HS256_SECRET, {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload;
    if (!decoded.oauth) return { active: false };
    return {
      active: true,
      sub: decoded.sub ?? "",
      scope: decoded.scope ?? "",
      client_id: decoded.client_id ?? "",
      tenant: decoded.tenant ?? null,
      aud: decoded.aud as string | string[],
      exp: decoded.exp!,
      iat: decoded.iat!,
      iss: decoded.iss ?? "",
    };
  } catch {
    return { active: false };
  }
};

export type AccessTokenClaims = {
  userId: string;
  email?: string;
  tenantId: string | null;
  clientId: string;
  scopes: string[];
  /** RFC 8707 resource indicator — sets the token audience. Defaults to the issuer. */
  resource?: string;
};

/** Issue a signed access-token JWT. Returns the token and its lifetime (s). */
export const generateAccessToken = (
  params: AccessTokenClaims
): { token: string; expiresIn: number } => {
  const ttl = _GLOBAL_SERVER_CONFIG.oauth2?.accessTokenTtl ?? 60 * 15;
  // HS256, same scheme as the framework's own tokens — only this server
  // verifies access tokens (the auth middleware), so symmetric signing is fine.
  const token = jwt.sign(
    {
      sub: params.userId,
      email: params.email,
      tenant: params.tenantId,
      scope: params.scopes.join(" "),
      client_id: params.clientId,
      oauth: true,
    },
    JWT_HS256_SECRET,
    {
      expiresIn: ttl,
      issuer: issuer(),
      audience: params.resource ?? issuer(),
    }
  );
  return { token, expiresIn: ttl };
};

export type RefreshGrant = {
  clientId: string;
  userId: string;
  tenantId: string | null;
  scopes: string[];
  familyId?: string;
};

/** Issue a refresh token (optionally continuing an existing family). */
export const issueRefreshToken = async (
  grant: RefreshGrant
): Promise<{ token: string; id: string; familyId: string }> => {
  const token = nanoid(48);
  const familyId = grant.familyId ?? crypto.randomUUID();
  const ttl = _GLOBAL_SERVER_CONFIG.oauth2?.refreshTokenTtl ?? 60 * 60 * 24 * 30;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const inserted = await getDb()
    .insert(oauthRefreshTokens)
    .values({
      tokenHash: sha256hex(token),
      familyId,
      clientId: grant.clientId,
      userId: grant.userId,
      tenantId: grant.tenantId,
      scopes: grant.scopes,
      expiresAt,
    })
    .returning({ id: oauthRefreshTokens.id });

  return { token, id: inserted[0].id, familyId };
};

/** Revoke every active token of a family (theft mitigation / logout). */
export const revokeRefreshFamily = async (familyId: string): Promise<void> => {
  await getDb()
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(oauthRefreshTokens.familyId, familyId),
        isNull(oauthRefreshTokens.revokedAt)
      )
    );
};

/** Revoke every outstanding refresh token of a client (e.g. on client delete). */
export const revokeClientTokens = async (clientId: string): Promise<void> => {
  await getDb()
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(oauthRefreshTokens.clientId, clientId),
        isNull(oauthRefreshTokens.revokedAt)
      )
    );
};

/** Revoke the family that the given (plaintext) refresh token belongs to. */
export const revokeRefreshToken = async (token: string): Promise<void> => {
  const rows = await getDb()
    .select({ familyId: oauthRefreshTokens.familyId })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, sha256hex(token)));
  if (rows[0]) {
    await revokeRefreshFamily(rows[0].familyId);
  }
};

/**
 * Rotate a refresh token: validate the presented token, issue a successor in
 * the same family and link the old one to it. Re-using an already-rotated token
 * is treated as theft → the whole family is revoked.
 */
export const rotateRefreshToken = async (
  presentedToken: string,
  clientId: string
): Promise<{
  refreshToken: string;
  userId: string;
  tenantId: string | null;
  scopes: string[];
}> => {
  const rows = await getDb()
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, sha256hex(presentedToken)));
  const row = rows[0];
  if (!row) {
    throw new Error("Invalid refresh token");
  }
  if (row.clientId !== clientId) {
    throw new Error("Refresh token was issued to a different client");
  }
  if (row.revokedAt) {
    throw new Error("Refresh token revoked");
  }
  if (row.rotatedTo) {
    // Reuse of a token that was already rotated → likely theft.
    await revokeRefreshFamily(row.familyId);
    throw new Error("Refresh token reuse detected");
  }
  if (isExpired(row.expiresAt)) {
    throw new Error("Refresh token expired");
  }

  const scopes = (row.scopes as string[]) ?? [];
  const next = await issueRefreshToken({
    clientId: row.clientId,
    userId: row.userId,
    tenantId: row.tenantId,
    scopes,
    familyId: row.familyId,
  });

  await getDb()
    .update(oauthRefreshTokens)
    .set({ rotatedTo: next.id })
    .where(eq(oauthRefreshTokens.id, row.id));

  return {
    refreshToken: next.token,
    userId: row.userId,
    tenantId: row.tenantId,
    scopes,
  };
};
