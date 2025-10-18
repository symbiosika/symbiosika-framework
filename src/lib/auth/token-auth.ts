import { eq, and, gt, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../db/db-connection";
import { apiTokens } from "../db/schema/api-tokens";
import { generateJwt } from ".";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import * as crypto from "crypto";
import { getUserById } from "../usermanagement/user";
import { availableScopes } from "./available-scopes";

/**
 * Generates a secure token
 */
export const generateApiToken = (): string => {
  return nanoid(32);
};

/**
 * Hashes a token for secure storage
 */
export const hashToken = (token: string): string => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

/**
 * Creates a new API token for a user and an organisation
 * expiresIn: optional: number of minutes after which the token expires
 */
export const createApiToken = async ({
  name,
  userId,
  organisationId,
  scopes,
  expiresIn,
  autoDelete,
}: {
  name: string;
  userId: string;
  organisationId: string;
  scopes: string[];
  expiresIn?: number;
  autoDelete?: boolean;
}): Promise<{ token: string }> => {
  const token = generateApiToken();
  const hashedToken = hashToken(token);

  // Check if all requested scopes are valid
  const validScopes = scopes.filter((scope) =>
    availableScopes.all.includes(scope)
  );
  if (validScopes.length !== scopes.length) {
    throw new Error("Invalid requested scopes");
  }

  // Optional: Calculate the expiration date
  let expiresAt = undefined;
  if (expiresIn) {
    expiresAt = new Date(Date.now() + expiresIn * 60 * 1000).toISOString();
  }

  await getDb().insert(apiTokens).values({
    name,
    token: hashedToken,
    userId,
    organisationId,
    scopes: scopes,
    expiresAt,
    autoDelete,
  });

  // Return the unhashed token, as this is the only opportunity to see it (it is not stored in the database)
  return { token };
};

/**
 * Search for a token in the database
 */
export const searchForToken = async (token: string) => {
  // hash the token
  const hashedToken = hashToken(token);
  // search for the token in the database
  const apiTokenRecord = await getDb()
    .select()
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.token, hashedToken),
        // Check if the token has not expired or has no expiration date
        or(
          isNull(apiTokens.expiresAt),
          gt(apiTokens.expiresAt, new Date().toISOString())
        )
      )
    );

  if (apiTokenRecord.length === 0) {
    throw new Error("Invalid or expired API token");
  }

  const tokenRecord = apiTokenRecord[0];

  return tokenRecord;
};

/**
 * Update the lastUsed field of a token
 */
export const updateTokenLastUsed = async (tokenId: string) => {
  await getDb()
    .update(apiTokens)
    .set({ lastUsed: new Date().toISOString() })
    .where(eq(apiTokens.id, tokenId));
};

/**
 * Verifies an API token and returns a short-lived JWT
 */
export const verifyApiTokenAndGetJwt = async (
  token: string,
  requestedScopes?: string[]
): Promise<{ token: string; expiresAt: Date }> => {
  // search for the token in the database
  const tokenRecord = await searchForToken(token);

  // Update lastUsed
  await updateTokenLastUsed(tokenRecord.id);

  // Check scopes, if requested
  if (requestedScopes && requestedScopes.length > 0) {
    const tokenScopes = tokenRecord.scopes as string[];
    const hasAllScopes = requestedScopes.every(
      (scope) => tokenScopes.includes(scope) || tokenScopes.includes("*")
    );

    if (!hasAllScopes) {
      throw new Error("Insufficient permissions");
    }
  }

  // Get the associated user
  const user = await getUserById(tokenRecord.userId);

  // Generate a short-lived JWT with the requested scopes
  const jwt = await generateJwt(
    user,
    // Short lifetime for API-generated tokens (e.g. 15 minutes)
    15 * 60, // 15 minutes in seconds
    {
      // Add API token-specific information to the JWT
      apiToken: true,
      scopes: requestedScopes || (tokenRecord.scopes as string[]),
      organisationId: tokenRecord.organisationId,
    }
  );

  return jwt;
};

/**
 * Generate a temporary JWT from token
 * with the scopes of the token
 */
export const generateTemporaryJwtFromToken = async (token: string) => {
  // search for the token in the database
  const tokenRecord = await searchForToken(token);

  // Update lastUsed
  await updateTokenLastUsed(tokenRecord.id);

  // Get the associated user
  const user = await getUserById(tokenRecord.userId);

  // Generate a short-lived JWT with the requested scopes
  const jwt = await generateJwt(
    user,
    // Short lifetime for API-generated tokens (e.g. 15 minutes)
    15 * 60, // 15 minutes in seconds
    {
      // Add API token-specific information to the JWT
      apiToken: true,
      scopes: tokenRecord.scopes,
      organisationId: tokenRecord.organisationId,
    }
  );

  return jwt;
};

/**
 * Revokes an API token
 */
export const revokeApiToken = async (
  id: string,
  userId: string
): Promise<void> => {
  await getDb()
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)));
};

/**
 * Lists all API tokens of a user
 */
export const listApiTokensForUser = async (userId: string) => {
  return await getDb()
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      scopes: apiTokens.scopes,
      lastUsed: apiTokens.lastUsed,
      expiresAt: apiTokens.expiresAt,
      createdAt: apiTokens.createdAt,
      organisationId: apiTokens.organisationId,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId));
};

/**
 * Lists all API tokens of an organisation
 */
export const listApiTokensForOrganisation = async (organisationId: string) => {
  return await getDb()
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.organisationId, organisationId));
};
