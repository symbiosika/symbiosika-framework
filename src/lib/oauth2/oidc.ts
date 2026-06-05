/**
 * OpenID Connect helpers: id_token issuance and userinfo claim assembly.
 *
 * Standard OIDC scopes control which identity claims are exposed:
 *  - `openid`  → triggers id_token issuance (sub)
 *  - `profile` → name / given_name / family_name
 *  - `email`   → email / email_verified
 */
import jwt from "jsonwebtoken";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { getOidcKeyMaterial } from "./keys";

export const OIDC_SCOPES = ["openid", "profile", "email"] as const;

const issuer = () =>
  _GLOBAL_SERVER_CONFIG.oauth2?.issuer || _GLOBAL_SERVER_CONFIG.baseUrl;

export type OidcUser = {
  id: string;
  email: string;
  emailVerified?: boolean;
  firstname?: string;
  surname?: string;
};

/** Assemble identity claims for the given granted scopes. */
export const buildClaims = (
  user: OidcUser,
  scopes: string[]
): Record<string, unknown> => {
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
  return claims;
};

/** Sign an OIDC id_token (RS256 with the server RSA key, aud = client_id). */
export const generateIdToken = async (params: {
  user: OidcUser;
  clientId: string;
  scopes: string[];
  nonce?: string | null;
}): Promise<string> => {
  const ttl = _GLOBAL_SERVER_CONFIG.oauth2?.accessTokenTtl ?? 60 * 15;
  const { privatePem, kid } = await getOidcKeyMaterial();
  const claims: Record<string, unknown> = {
    ...buildClaims(params.user, params.scopes),
  };
  if (params.nonce) {
    claims.nonce = params.nonce;
  }
  // `sub` is already part of `claims` (from buildClaims) — do not also pass the
  // `subject` option, jsonwebtoken rejects setting it twice.
  return jwt.sign(claims, privatePem, {
    algorithm: "RS256",
    expiresIn: ttl,
    issuer: issuer(),
    audience: params.clientId,
    keyid: kid,
  });
};
