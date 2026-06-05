/**
 * Stateful user-login sessions.
 *
 * Login JWTs carry a `sid` claim that points at a row in the `sessions` table.
 * The middleware validates that the session still exists on every request, so
 * a session can be revoked (logout, password reset, "log out everywhere")
 * before the JWT naturally expires — something a pure stateless JWT cannot do.
 *
 * The DB is the source of truth; Redis is a positive cache to keep the hot auth
 * path off the database. Revocation always clears the cache, so there is no
 * stale-positive window.
 *
 * Service tokens (API tokens, server connections) and external tokens
 * (auth0/hanko) are NOT session-backed and never reach this module.
 */
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import { getDb } from "../db/db-connection";
import { sessions } from "../db/db-schema";
import {
  setSessionCache,
  getSessionCache,
  deleteSessionCache,
} from "../utils/redis-cache";

/**
 * Create a new session row for a user and return its id.
 * @param ttlSeconds lifetime in seconds (matches the JWT lifetime)
 */
export const createUserSession = async (
  userId: string,
  ttlSeconds: number
): Promise<{ sid: string; expiresAt: Date }> => {
  const sid = nanoid(32);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await getDb().insert(sessions).values({
    sessionToken: sid,
    userId,
    expires: expiresAt.toISOString(),
  });

  await setSessionCache(sid, userId, ttlSeconds);

  return { sid, expiresAt };
};

/**
 * Check whether a session id still refers to a live, unexpired session.
 * Redis-first; falls back to the DB and re-warms the cache on a hit.
 */
export const isSessionValid = async (sid: string): Promise<boolean> => {
  const cachedUserId = await getSessionCache(sid);
  if (cachedUserId) {
    return true;
  }

  const rows = await getDb()
    .select({ userId: sessions.userId, expires: sessions.expires })
    .from(sessions)
    .where(eq(sessions.sessionToken, sid));
  const row = rows[0];
  if (!row) {
    return false;
  }

  const expiresMs = new Date(row.expires).getTime();
  if (expiresMs <= Date.now()) {
    // Lazily clean up an expired row.
    await revokeSession(sid);
    return false;
  }

  // Re-warm the cache for the remaining lifetime.
  const remainingSeconds = Math.ceil((expiresMs - Date.now()) / 1000);
  await setSessionCache(sid, row.userId, remainingSeconds);
  return true;
};

/**
 * Revoke a single session (logout of one device).
 */
export const revokeSession = async (sid: string): Promise<void> => {
  await getDb().delete(sessions).where(eq(sessions.sessionToken, sid));
  await deleteSessionCache(sid);
};

/**
 * Revoke every session of a user (password reset / "log out everywhere").
 */
export const revokeAllSessionsForUser = async (
  userId: string
): Promise<void> => {
  const rows = await getDb()
    .select({ sid: sessions.sessionToken })
    .from(sessions)
    .where(eq(sessions.userId, userId));

  await getDb().delete(sessions).where(eq(sessions.userId, userId));
  await Promise.all(rows.map((r) => deleteSessionCache(r.sid)));
};

/**
 * Best-effort revoke from a raw JWT (used on logout, where the route is public
 * and only has the cookie/token). Decodes the `sid` without verifying — an
 * invalid or expired token simply results in a no-op.
 */
export const revokeSessionByToken = async (token: string): Promise<void> => {
  try {
    const decoded = jwt.decode(token);
    const sid =
      decoded && typeof decoded === "object"
        ? (decoded as { sid?: string }).sid
        : undefined;
    if (sid) {
      await revokeSession(sid);
    }
  } catch {
    /* ignore — logout must always succeed */
  }
};
