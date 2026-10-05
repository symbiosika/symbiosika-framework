/**
 * Impersonation: a session in which one person (the actor, e.g. a support
 * admin) acts as another user.
 *
 * The token is a normal user-session JWT for the target user — `sub`/`email`
 * are the target's, so every route and permission check behaves exactly as if
 * the target were logged in — plus the RFC 8693 `act` claim naming the actor:
 *
 *   { sub: <target id>, email: <target email>, sid: <session>,
 *     act: { sub: <actor id>, email: <actor email> } }
 *
 * The auth middleware exposes the actor as `c.get("actor")`; it is undefined
 * for every normal login. Because the token is backed by a regular server-side
 * session it is revocable like any login (logout, password reset of the target).
 *
 * Note: the framework does not decide WHO may impersonate. The app calls
 * `createImpersonationSession` only after its own authorization check.
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { users } from "../db/db-schema";
import { generateUserSessionJwt } from "./index";
import { getSessionExpiresAt } from "./sessions";
import type { TokenActor } from "../../types";

/** Default lifetime of an impersonation session: 1 hour. */
export const DEFAULT_IMPERSONATION_EXPIRES_IN = 60 * 60;

/**
 * Read the actor from a decoded token's `act` claim.
 * Returns undefined when the claim is missing or malformed.
 */
export const parseActClaim = (act: unknown): TokenActor | undefined => {
  if (!act || typeof act !== "object") return undefined;
  const { sub, email } = act as Record<string, unknown>;
  if (typeof sub !== "string" || sub === "") return undefined;
  return { id: sub, email: typeof email === "string" ? email : "" };
};

/**
 * Create a session JWT in which `actor` acts as the user `targetUserId`.
 */
export const createImpersonationSession = async (params: {
  targetUserId: string;
  actor: TokenActor;
  /** Lifetime in seconds. Defaults to 1 hour. */
  expiresIn?: number;
}) => {
  const { targetUserId, actor } = params;
  const expiresIn = params.expiresIn ?? DEFAULT_IMPERSONATION_EXPIRES_IN;

  if (!actor?.id) {
    throw new Error("Impersonation needs an actor id");
  }
  if (actor.id === targetUserId) {
    throw new Error("A user cannot impersonate themselves");
  }

  const rows = await getDb()
    .select({
      id: users.id,
      email: users.email,
      firstname: users.firstname,
      surname: users.surname,
    })
    .from(users)
    .where(eq(users.id, targetUserId));
  const user = rows[0];
  if (!user) {
    throw new Error("User not found");
  }

  const { token, expiresAt, sid } = await generateUserSessionJwt(
    user,
    expiresIn,
    { act: { sub: actor.id, email: actor.email } }
  );

  return { token, expiresAt, sid, user };
};

/** Is the current request made from an impersonation session? */
export const isImpersonated = (c: Context): boolean => !!c.get("actor");

/**
 * Session info for the client, e.g. to show an impersonation banner.
 *
 * - `actor`: the person acting as the user (names from `users`, null if that
 *   user no longer exists), or null for a normal session.
 * - `sessionExpiresAt`: expiry of the current server-side session as ISO
 *   string, or null for tokens without a session (API/external tokens).
 */
export const getSessionActorInfo = async (
  c: Context
): Promise<{
  actor: {
    id: string;
    email: string;
    firstname: string | null;
    surname: string | null;
  } | null;
  sessionExpiresAt: string | null;
}> => {
  const tokenActor: TokenActor | undefined = c.get("actor");
  const sid: string | undefined = c.get("sessionId");

  const [actorUser, expiresAt] = await Promise.all([
    tokenActor
      ? getDb()
          .select({ firstname: users.firstname, surname: users.surname })
          .from(users)
          .where(eq(users.id, tokenActor.id))
          .then((rows) => rows[0])
      : undefined,
    sid ? getSessionExpiresAt(sid) : null,
  ]);

  return {
    actor: tokenActor
      ? {
          id: tokenActor.id,
          email: tokenActor.email,
          firstname: actorUser?.firstname ?? null,
          surname: actorUser?.surname ?? null,
        }
      : null,
    sessionExpiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
};

/**
 * HONO Middleware: reject the request (403) during impersonation.
 *
 * For actions that only the real account owner may take — changing the
 * password or email address, or minting new credentials (API tokens, passkeys)
 * that would outlive the impersonation session. Must run after the auth
 * middleware.
 */
export const forbidDuringImpersonation = async (c: Context, next: Function) => {
  if (isImpersonated(c)) {
    throw new HTTPException(403, {
      message: "Not allowed during impersonation",
    });
  }
  await next();
};
