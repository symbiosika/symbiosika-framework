/**
 * Authorization code lifecycle (single-use, short-lived, PKCE-bound).
 * Only the SHA-256 hash of the code is stored.
 */
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../db/db-connection";
import { oauthAuthCodes } from "../db/db-schema";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { sha256hex, isExpired } from "./util";

export type IssueAuthCodeParams = {
  clientId: string;
  userId: string;
  tenantId: string | null;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod?: string;
  nonce?: string | null;
};

export type AuthCodePayload = {
  clientId: string;
  userId: string;
  tenantId: string | null;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  nonce: string | null;
};

/** Issue a fresh authorization code and return the plaintext code. */
export const issueAuthCode = async (
  params: IssueAuthCodeParams
): Promise<string> => {
  const code = nanoid(48);
  const ttl = _GLOBAL_SERVER_CONFIG.oauth2?.authCodeTtl ?? 60;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  await getDb().insert(oauthAuthCodes).values({
    codeHash: sha256hex(code),
    clientId: params.clientId,
    userId: params.userId,
    tenantId: params.tenantId,
    redirectUri: params.redirectUri,
    scopes: params.scopes,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod ?? "S256",
    nonce: params.nonce ?? null,
    expiresAt,
  });

  return code;
};

/**
 * Consume an authorization code (single-use). Validates the binding to the
 * client and redirect_uri, expiry and prior consumption. Returns the stored
 * payload (incl. PKCE challenge) for the token endpoint to finish verification.
 */
export const consumeAuthCode = async (
  code: string,
  clientId: string,
  redirectUri: string
): Promise<AuthCodePayload> => {
  const rows = await getDb()
    .select()
    .from(oauthAuthCodes)
    .where(eq(oauthAuthCodes.codeHash, sha256hex(code)));
  const row = rows[0];
  if (!row) {
    throw new Error("Invalid authorization code");
  }

  // Single-use: a re-used code is a strong misuse signal → drop it.
  if (row.consumedAt) {
    await getDb()
      .delete(oauthAuthCodes)
      .where(eq(oauthAuthCodes.id, row.id));
    throw new Error("Authorization code already used");
  }

  if (isExpired(row.expiresAt)) {
    await getDb().delete(oauthAuthCodes).where(eq(oauthAuthCodes.id, row.id));
    throw new Error("Authorization code expired");
  }

  if (row.clientId !== clientId) {
    throw new Error("Authorization code was issued to a different client");
  }
  if (row.redirectUri !== redirectUri) {
    throw new Error("redirect_uri mismatch");
  }

  // Mark consumed (single-use guard).
  await getDb()
    .update(oauthAuthCodes)
    .set({ consumedAt: new Date().toISOString() })
    .where(eq(oauthAuthCodes.id, row.id));

  return {
    clientId: row.clientId,
    userId: row.userId,
    tenantId: row.tenantId,
    redirectUri: row.redirectUri,
    scopes: (row.scopes as string[]) ?? [],
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod,
    nonce: row.nonce,
  };
};
