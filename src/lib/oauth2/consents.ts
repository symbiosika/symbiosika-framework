/**
 * Persisted user consent: remember which scopes a user granted a client so the
 * consent screen can be skipped next time. A request for new scopes beyond the
 * stored set triggers re-consent.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { oauthConsents } from "../db/db-schema";

/** Scopes the user has previously granted this client (empty if none). */
export const getConsentedScopes = async (
  userId: string,
  clientId: string
): Promise<string[]> => {
  const rows = await getDb()
    .select({ scopes: oauthConsents.scopes })
    .from(oauthConsents)
    .where(
      and(
        eq(oauthConsents.userId, userId),
        eq(oauthConsents.clientId, clientId)
      )
    );
  return (rows[0]?.scopes as string[]) ?? [];
};

/** True if every requested scope was already granted before. */
export const hasConsentForScopes = async (
  userId: string,
  clientId: string,
  requestedScopes: string[]
): Promise<boolean> => {
  const granted = await getConsentedScopes(userId, clientId);
  const set = new Set(granted);
  return requestedScopes.every((s) => set.has(s));
};

/** Persist consent (union of previously granted and newly granted scopes). */
export const saveConsent = async (
  userId: string,
  clientId: string,
  scopes: string[]
): Promise<void> => {
  const existing = await getConsentedScopes(userId, clientId);
  const merged = Array.from(new Set([...existing, ...scopes]));
  const now = new Date().toISOString();

  if (existing.length > 0) {
    await getDb()
      .update(oauthConsents)
      .set({ scopes: merged, updatedAt: now })
      .where(
        and(
          eq(oauthConsents.userId, userId),
          eq(oauthConsents.clientId, clientId)
        )
      );
  } else {
    await getDb()
      .insert(oauthConsents)
      .values({ userId, clientId, scopes: merged });
  }
};

/** Forget a user's consent for a client. */
export const revokeConsent = async (
  userId: string,
  clientId: string
): Promise<void> => {
  await getDb()
    .delete(oauthConsents)
    .where(
      and(
        eq(oauthConsents.userId, userId),
        eq(oauthConsents.clientId, clientId)
      )
    );
};
