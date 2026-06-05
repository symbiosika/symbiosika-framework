import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import type { Context } from "hono";
import { getDb } from "../db/db-connection";
import { users, webauthnCredentials } from "../db/db-schema";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import {
  setWebAuthnChallengePayload,
  takeWebAuthnChallengePayload,
} from "../utils/redis-cache";
import { createJwtSessionForUserId } from "./index";
import { getUserById } from "../usermanagement/user";

const CHALLENGE_TYPE_REGISTRATION = "registration" as const;
const CHALLENGE_TYPE_AUTHENTICATION = "authentication" as const;

export type PasskeyConfig = {
  rpID: string;
  rpName: string;
};

/**
 * WebAuthn RP ID: hostname from public API URL only (no extra env vars).
 * Uses defineServer `baseUrl` first, then `BASE_URL` — same source as links and CORS setup.
 */
function resolveWebAuthnRpId(): string | null {
  const base =
    _GLOBAL_SERVER_CONFIG.baseUrl?.trim() ||
    process.env.BASE_URL?.trim() ||
    "";
  if (!base) {
    return null;
  }
  try {
    const host = new URL(base).hostname;
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Passkeys use BASE_URL hostname as RP ID and `appName` as RP display name.
 * See SimpleWebAuthn passkeys guide for authenticator options.
 */
export function getPasskeyConfig(): PasskeyConfig | null {
  const rpID = resolveWebAuthnRpId();
  if (!rpID) {
    return null;
  }
  return {
    rpID,
    rpName: _GLOBAL_SERVER_CONFIG.appName,
  };
}

export function isPasskeysEnabledForLocalAuth(): boolean {
  return (
    _GLOBAL_SERVER_CONFIG.authType === "local" && getPasskeyConfig() !== null
  );
}

function uuidToUserHandleBytes(userUuid: string): Uint8Array<ArrayBuffer> {
  const hex = userUuid.replace(/-/g, "");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/**
 * Origin for WebAuthn verification. Some same-origin POSTs omit `Origin`;
 * then use `Referer`, then public `baseUrl` / `BASE_URL` (same host as typical static login page).
 */
function resolveWebAuthnRequestOrigin(c: Context): string | null {
  const origin = c.req.header("origin");
  if (origin) {
    return origin;
  }
  const referer = c.req.header("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      /* ignore */
    }
  }
  try {
    const base =
      _GLOBAL_SERVER_CONFIG.baseUrl?.trim() ||
      process.env.BASE_URL?.trim() ||
      "";
    if (base) {
      const u = new URL(base);
      return `${u.protocol}//${u.host}`;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function assertOriginAllowed(c: Context): string {
  const resolved = resolveWebAuthnRequestOrigin(c);
  const allowed = _GLOBAL_SERVER_CONFIG.allowedOrigins;
  if (allowed.length > 0) {
    if (!resolved || !allowed.includes(resolved)) {
      throw new Error("Origin not allowed for WebAuthn");
    }
    return resolved;
  }
  if (!resolved) {
    throw new Error(
      "Could not determine request origin (set Origin/Referer or BASE_URL)"
    );
  }
  return resolved;
}

export async function passkeyRegistrationOptions(c: Context, userId: string) {
  const cfg = getPasskeyConfig();
  if (!cfg) {
    throw new Error("Passkeys are not configured");
  }
  assertOriginAllowed(c);

  const userRows = await getDb()
    .select({
      id: users.id,
      email: users.email,
      firstname: users.firstname,
      surname: users.surname,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, userId));
  const user = userRows[0];
  if (!user) {
    throw new Error("User not found");
  }
  if (!user.emailVerified) {
    throw new Error("Email must be verified before registering a passkey");
  }

  const existing = await getDb()
    .select({
      credentialId: webauthnCredentials.credentialId,
      transports: webauthnCredentials.transports,
    })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId));

  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userID: uuidToUserHandleBytes(user.id),
    userName: user.email,
    userDisplayName: `${user.firstname} ${user.surname}`.trim() || user.email,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      type: "public-key" as const,
      transports: row.transports as AuthenticatorTransportFuture[] | undefined,
    })),
  });

  const challengeToken = nanoid(32);
  await setWebAuthnChallengePayload(
    challengeToken,
    JSON.stringify({
      type: CHALLENGE_TYPE_REGISTRATION,
      challenge: options.challenge,
      userId: user.id,
    })
  );

  return { options, challengeToken };
}

export async function passkeyRegistrationVerify(
  c: Context,
  userId: string,
  body: {
    challengeToken: string;
    /** Full credential response from `startRegistration()` */
    credential: any;
    nickname?: string;
  }
) {
  const cfg = getPasskeyConfig();
  if (!cfg) {
    throw new Error("Passkeys are not configured");
  }
  const expectedOrigin = assertOriginAllowed(c);

  const raw = await takeWebAuthnChallengePayload(body.challengeToken);
  if (!raw) {
    throw new Error("Invalid or expired challenge");
  }
  const payload = JSON.parse(raw) as {
    type: typeof CHALLENGE_TYPE_REGISTRATION;
    challenge: string;
    userId: string;
  };
  if (payload.type !== CHALLENGE_TYPE_REGISTRATION || payload.userId !== userId) {
    throw new Error("Challenge does not match this user");
  }

  const verification = await verifyRegistrationResponse({
    response: body.credential,
    expectedChallenge: payload.challenge,
    expectedOrigin,
    expectedRPID: cfg.rpID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey registration verification failed");
  }

  const info = verification.registrationInfo;
  const cred = info.credential;

  await getDb().insert(webauthnCredentials).values({
    userId,
    credentialId: cred.id,
    publicKey: Buffer.from(cred.publicKey),
    counter: cred.counter,
    transports: cred.transports as string[] | undefined,
    credentialDeviceType: info.credentialDeviceType,
    credentialBackedUp: info.credentialBackedUp,
    aaguid: info.aaguid,
    nickname: body.nickname?.trim() || null,
  });

  return { verified: true as const };
}

export async function passkeyAuthenticationOptions(
  c: Context,
  email: string
) {
  const cfg = getPasskeyConfig();
  if (!cfg) {
    throw new Error("Passkeys are not configured");
  }
  assertOriginAllowed(c);

  const userRows = await getDb()
    .select({
      id: users.id,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.email, email));
  const user = userRows[0];
  if (!user) {
    throw new Error("User not found");
  }
  if (!user.emailVerified) {
    throw new Error("Email is not verified");
  }

  const creds = await getDb()
    .select({
      credentialId: webauthnCredentials.credentialId,
      transports: webauthnCredentials.transports,
    })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, user.id));

  if (creds.length === 0) {
    throw new Error("No passkeys registered for this account");
  }

  const options = await generateAuthenticationOptions({
    rpID: cfg.rpID,
    allowCredentials: creds.map((row) => ({
      id: row.credentialId,
      type: "public-key" as const,
      transports: row.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: "preferred",
  });

  const challengeToken = nanoid(32);
  await setWebAuthnChallengePayload(
    challengeToken,
    JSON.stringify({
      type: CHALLENGE_TYPE_AUTHENTICATION,
      challenge: options.challenge,
      userId: user.id,
    })
  );

  return { options, challengeToken };
}

export async function passkeyAuthenticationVerify(
  c: Context,
  body: {
    challengeToken: string;
    /** Full credential response from `startAuthentication()` */
    credential: any;
  }
) {
  const cfg = getPasskeyConfig();
  if (!cfg) {
    throw new Error("Passkeys are not configured");
  }
  const expectedOrigin = assertOriginAllowed(c);

  const raw = await takeWebAuthnChallengePayload(body.challengeToken);
  if (!raw) {
    throw new Error("Invalid or expired challenge");
  }
  const payload = JSON.parse(raw) as {
    type: typeof CHALLENGE_TYPE_AUTHENTICATION;
    challenge: string;
    userId: string;
  };
  if (payload.type !== CHALLENGE_TYPE_AUTHENTICATION) {
    throw new Error("Invalid challenge type");
  }

  const credRows = await getDb()
    .select()
    .from(webauthnCredentials)
    .where(
      and(
        eq(webauthnCredentials.userId, payload.userId),
        eq(webauthnCredentials.credentialId, body.credential.id)
      )
    );
  const row = credRows[0];
  if (!row) {
    throw new Error("Unknown credential");
  }

  const verification = await verifyAuthenticationResponse({
    response: body.credential,
    expectedChallenge: payload.challenge,
    expectedOrigin,
    expectedRPID: cfg.rpID,
    credential: {
      id: row.credentialId,
      publicKey: new Uint8Array(row.publicKey),
      counter: row.counter,
    },
    requireUserVerification: false,
  });

  if (!verification.verified) {
    throw new Error("Passkey authentication verification failed");
  }

  const newCounter = verification.authenticationInfo.newCounter;
  await getDb()
    .update(webauthnCredentials)
    .set({
      counter: newCounter,
      lastUsedAt: new Date().toISOString(),
    })
    .where(eq(webauthnCredentials.id, row.id));

  const session = await createJwtSessionForUserId(payload.userId);
  const user = await getUserById(payload.userId);
  if (!user) {
    throw new Error("User not found");
  }

  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user,
  };
}

export async function listPasskeysForUser(userId: string) {
  return getDb()
    .select({
      id: webauthnCredentials.id,
      credentialId: webauthnCredentials.credentialId,
      nickname: webauthnCredentials.nickname,
      credentialDeviceType: webauthnCredentials.credentialDeviceType,
      credentialBackedUp: webauthnCredentials.credentialBackedUp,
      createdAt: webauthnCredentials.createdAt,
      lastUsedAt: webauthnCredentials.lastUsedAt,
    })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .orderBy(desc(webauthnCredentials.createdAt));
}

export async function deletePasskeyForUser(userId: string, passkeyRowId: string) {
  const deleted = await getDb()
    .delete(webauthnCredentials)
    .where(
      and(
        eq(webauthnCredentials.id, passkeyRowId),
        eq(webauthnCredentials.userId, userId)
      )
    )
    .returning({ id: webauthnCredentials.id });
  if (!deleted[0]) {
    throw new Error("Passkey not found");
  }
}
