/**
 * Social login ("Sign in with Google" / "Sign in with Microsoft 365").
 *
 * The flow is the OAuth2 authorization code flow with PKCE:
 *
 *   1. `/user/auth/:provider` builds an authorize URL and pins `state` plus the
 *      PKCE verifier in a short-lived HttpOnly cookie (see `oauth-login-tx`).
 *   2. the provider redirects back to `/user/auth/:provider/callback`, which
 *      verifies `state`, exchanges the code and creates a framework session.
 *
 * Accounts are resolved **by e-mail address**: the provider has verified it, and
 * `users.email` is unique, so an address always maps to exactly one account no
 * matter which login method created it. A user who signed up via magic link can
 * therefore sign in with Microsoft afterwards, and vice versa.
 *
 * Configuration (per provider; both halves are required):
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET
 *   MICROSOFT_TENANT_ID   optional directory to authenticate against; defaults
 *                         to `common`. Use the tenant GUID or `organizations`
 *                         to restrict the login to one Entra directory.
 *
 * Redirect URI to register with the provider:
 *   <baseUrl><basePath>/user/auth/<provider>/callback
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { getDb } from "../db/db-connection";
import { eq } from "drizzle-orm";
import { tenantMembers, users } from "../db/db-schema";
import { checkGeneralInvitationCode, generateUserSessionJwt } from "./index";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { postRegisterActions } from "./actions";
import {
  checkIfInvitationCodeIsNeededToRegister,
  getPendingInvitationsForEmail,
  acceptAllPendingInvitationsForTenantMember,
} from "../usermanagement/invitations";
import { addTenantMember } from "../usermanagement/tenants";
import { updateUser } from "../usermanagement/user";
import log from "../log";
import { normalizeEmail } from "../utils/email";

export type OAuthProvider = "google" | "microsoft";

export const OAUTH_PROVIDERS: OAuthProvider[] = ["google", "microsoft"];

export const isOAuthProvider = (value: string): value is OAuthProvider =>
  (OAUTH_PROVIDERS as string[]).includes(value);

/**
 * Read lazily, not at import time: `defineServer` may be called after this
 * module is first imported, and tests need to toggle providers.
 */
const credentials = (provider: OAuthProvider) =>
  provider === "google"
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID || "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      }
    : {
        clientId: process.env.MICROSOFT_CLIENT_ID || "",
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET || "",
      };

const microsoftDirectory = () => process.env.MICROSOFT_TENANT_ID || "common";

const endpoints = (provider: OAuthProvider) => {
  if (provider === "google") {
    return {
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      scope: "openid email profile",
    };
  }
  const authority = `https://login.microsoftonline.com/${encodeURIComponent(
    microsoftDirectory()
  )}/oauth2/v2.0`;
  return {
    authorize: `${authority}/authorize`,
    token: `${authority}/token`,
    scope: "openid profile email User.Read",
  };
};

/**
 * A provider is usable only with client id **and** secret: the code exchange is
 * a confidential-client request, so advertising the provider on the client id
 * alone would offer a login that cannot complete.
 */
export const isOAuthProviderActive = (provider: OAuthProvider): boolean => {
  const { clientId, clientSecret } = credentials(provider);
  return clientId !== "" && clientSecret !== "";
};

/**
 * Kept for backwards compatibility. These are snapshots taken at import time —
 * prefer `isOAuthProviderActive()`, which also accounts for the client secret.
 */
export let GOOGLE_AUTH_IS_ACTIVE = false;
export let MICROSOFT_AUTH_IS_ACTIVE = false;

if (isOAuthProviderActive("google")) {
  GOOGLE_AUTH_IS_ACTIVE = true;
  log.info("Google Auth active. Redirect URI: " + getOAuthRedirectUri("google"));
}

if (isOAuthProviderActive("microsoft")) {
  MICROSOFT_AUTH_IS_ACTIVE = true;
  // The directory is part of the log on purpose: a single-tenant app
  // registration rejects the `common` endpoint (AADSTS50194), and that is the
  // most common setup mistake. MICROSOFT_TENANT_ID selects the directory.
  log.info(
    `Microsoft Auth active. Directory: ${microsoftDirectory()}` +
      (microsoftDirectory() === "common"
        ? " (set MICROSOFT_TENANT_ID to the tenant GUID for a single-tenant app registration)"
        : "") +
      ". Redirect URI: " +
      getOAuthRedirectUri("microsoft")
  );
}

/**
 * Redirect URI handed to the provider. Must match the provider's app
 * registration verbatim, so it is derived in exactly one place.
 */
export function getOAuthRedirectUri(provider: OAuthProvider): string {
  const basePath = _GLOBAL_SERVER_CONFIG.basePath.replace(/\/$/, "");
  return `${_GLOBAL_SERVER_CONFIG.baseUrl}${basePath}/user/auth/${provider}/callback`;
}

/* ── Login transaction (state + PKCE) ──────────────────────────────────────
 *
 * `state` protects against CSRF / login-fixation: the value in the callback
 * must match the one pinned in the browser's cookie. The PKCE verifier binds
 * the authorization code to this very browser, and the redirect target travels
 * in the cookie as well, so it can never be tampered with in the URL.
 */

/** Cookie holding the pending login transaction. */
export const OAUTH_LOGIN_TX_COOKIE = "oauth_login_tx";

/** How long a started login may take before it has to be restarted. */
export const OAUTH_LOGIN_TX_TTL_SECONDS = 10 * 60;

const base64url = (input: Buffer): string =>
  input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Random, URL-safe value used for `state` and the PKCE verifier. */
export const createOAuthRandomToken = (bytes = 32): string =>
  base64url(randomBytes(bytes));

/** S256 code challenge for a PKCE verifier (RFC 7636). */
export const createOAuthCodeChallenge = (verifier: string): string =>
  base64url(createHash("sha256").update(verifier).digest());

/** Constant-time `state` comparison, so a mismatch cannot be probed. */
export const isSameOAuthState = (
  expected: string,
  received: string
): boolean => {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
};

export type OAuthLoginTransaction = {
  state: string;
  verifier: string;
  /** Where to send the user afterwards (server-relative path). */
  redirect: string;
};

export const encodeOAuthTransaction = (tx: OAuthLoginTransaction): string =>
  base64url(Buffer.from(JSON.stringify(tx), "utf8"));

/** Counterpart of `encodeOAuthTransaction`; null for anything unusable. */
export const decodeOAuthTransaction = (
  value: string | undefined
): OAuthLoginTransaction | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    );
    if (
      typeof parsed?.state !== "string" ||
      typeof parsed?.verifier !== "string" ||
      typeof parsed?.redirect !== "string" ||
      parsed.state === "" ||
      parsed.verifier === ""
    ) {
      return null;
    }
    return {
      state: parsed.state,
      verifier: parsed.verifier,
      redirect: parsed.redirect,
    };
  } catch {
    return null;
  }
};

/**
 * Only server-relative targets are accepted after a login — otherwise the login
 * endpoint would double as an open redirect. `//host` is protocol-relative and
 * therefore off-site despite the leading slash.
 */
export const sanitizeOAuthRedirect = (
  redirect: string | undefined,
  fallback: string
): string => {
  if (!redirect) return fallback;
  if (!redirect.startsWith("/") || redirect.startsWith("//")) return fallback;
  return redirect;
};

/* ── User resolution ─────────────────────────────────────────────────────── */

export type OAuthProfile = {
  email: string;
  id: string;
  provider: OAuthProvider;
  firstname?: string;
  surname?: string;
};

/**
 * Look an account up by the provider's subject id (`extUserId`) — Microsoft's
 * `oid`, Google's `sub`.
 *
 * Two guards:
 *  - an empty id never matches. `extUserId` defaults to `""`, so every local
 *    account carries that value and an empty needle would match an arbitrary
 *    stranger.
 *  - a hit that belongs to a *different* social provider is ignored: the id
 *    spaces are unrelated, so an id colliding across them is a coincidence,
 *    not the user. Accounts whose `provider` is not a social one (`local`,
 *    `hanko`, …) do match — that is exactly the linked case below, where the
 *    id was backfilled but `provider` stayed as it was.
 */
async function findUserByExternalId(extUserId: string, provider: OAuthProvider) {
  if (!extUserId) return undefined;

  const candidates = await getDb()
    .select()
    .from(users)
    .where(eq(users.extUserId, extUserId));

  return candidates.find(
    (candidate) =>
      candidate.provider === provider || !isOAuthProvider(candidate.provider)
  );
}

/**
 * Keep the stored address in sync with the directory after a rename.
 *
 * Best effort by design: `users.email` is unique, so the update can legitimately
 * fail when another account already holds the new address (a colleague was
 * renamed to it, an old row was never cleaned up, …). Failing the login over
 * that would lock a user out of an account they demonstrably own, and taking the
 * address away from the other account would merge two identities. So the
 * conflict is logged with everything needed to resolve it by hand, and the login
 * continues with the address on file.
 *
 * Returns the updated row, or undefined when nothing was changed — callers fall
 * back to the row they already have.
 */
async function syncOAuthEmail(
  user: { id: string; email: string },
  email: string
) {
  if (user.email === email) return undefined;

  try {
    const [updated] = await getDb()
      .update(users)
      .set({ email })
      .where(eq(users.id, user.id))
      .returning();

    log.info(
      `Updated e-mail of account ${user.id} from ${user.email} to ${email} (renamed at the identity provider)`
    );

    return updated;
  } catch (err) {
    // Keep the reason short: a driver error carries the whole failed statement
    // in `message`, the underlying cause has the useful part ("duplicate key
    // value violates unique constraint \"unique_email\"").
    const reason =
      (err as { cause?: { message?: string } })?.cause?.message ??
      (err instanceof Error ? err.message.split("\n")[0] : String(err));

    log.error(
      `Could not update e-mail of account ${user.id} from ${user.email} to ${email}: ${reason}. ` +
        `The new address is most likely already used by another account — ` +
        `the login continues with ${user.email}; merge or free the duplicate account to fix this.`
    );
    return undefined;
  }
}

/**
 * Find the account for an OAuth identity, or create it.
 *
 * Resolution order:
 *  1. **the provider's subject id** (`extUserId`). It is immutable, so this
 *     keeps working after the address was renamed in the directory.
 *  2. **the e-mail address** the provider just verified. This links a login to
 *     an account that already existed (magic link, password, …) and backfills
 *     the subject id, so step 1 catches it from then on.
 *     Matching on `email + provider` instead would try to insert a second row
 *     for an address that already exists — rejected by the unique index on
 *     `users.email` — which made social login fail for every account created
 *     another way, i.e. the common case.
 *  3. otherwise register a new account.
 *
 * `provider` is left untouched on an existing account: it records how the
 * account was originally created, and it gates nothing (a linked account keeps
 * every login method it had). `emailVerified` is set because the provider has
 * just proven ownership of the address.
 *
 * A changed address is synced onto the account on a best-effort basis, see
 * `syncOAuthEmail`.
 */
async function findOAuthUser(profile: OAuthProfile) {
  const { id, provider } = profile;
  // Directories hand out whatever capitalisation the address was entered with
  // (Entra in particular preserves it), so the raw value cannot be used for
  // lookup or insert — step 2 of the resolution order above would miss the
  // existing account and we would try to register a duplicate.
  const email = normalizeEmail(profile.email);

  const byExternalId = await findUserByExternalId(id, provider);

  const existingUser = byExternalId
    ? [byExternalId]
    : await getDb().select().from(users).where(eq(users.email, email));

  if (!existingUser[0]) return undefined;

  const updatedUser = await getDb()
    .update(users)
    .set({
      extUserId: id,
      emailVerified: true,
    })
    .where(eq(users.id, existingUser[0].id))
    .returning();

  if (!byExternalId) {
    log.info(
      `Linked ${provider} login to existing ${existingUser[0].provider} account ${existingUser[0].id}`
    );
  }

  return (await syncOAuthEmail(existingUser[0], email)) ?? updatedUser[0];
}

/**
 * Register a brand-new account for a verified social identity.
 *
 * `tenantIdFromInvitationCode` is the tenant a redeemed general invitation code
 * points at (if any). It is joined exactly like `LocalAuth.register` does: the
 * very first member of an empty tenant becomes its owner, everyone after that a
 * member.
 */
async function createOAuthUser(
  profile: OAuthProfile,
  tenantIdFromInvitationCode: string | null = null,
  meta?: { invitationCode?: string }
) {
  const { id, provider, firstname = "", surname = "" } = profile;
  const email = normalizeEmail(profile.email);

  const { invitedInTenantIds } = await getPendingInvitationsForEmail(email);

  const newUser = await getDb()
    .insert(users)
    .values({
      email,
      firstname,
      surname,
      emailVerified: true, // the provider verified the address
      provider,
      extUserId: id,
      salt: "",
      password: "",
    })
    .returning();

  if (!newUser[0]) {
    throw new Error("Failed to create new user");
  }

  log.info(`New user registered via ${provider}: ${newUser[0].id}`);

  if (tenantIdFromInvitationCode) {
    const members = await getDb()
      .select()
      .from(tenantMembers)
      .where(eq(tenantMembers.tenantId, tenantIdFromInvitationCode));

    await addTenantMember(
      tenantIdFromInvitationCode,
      newUser[0].id,
      members[0] ? "member" : "owner"
    );
    await updateUser(newUser[0].id, {
      lastTenantId: tenantIdFromInvitationCode,
    });
  }

  // Accept pending organisation invitations, exactly like the magic-link
  // sign-up does — otherwise an invited user lands in no tenant at all.
  for (const tenantId of invitedInTenantIds) {
    await acceptAllPendingInvitationsForTenantMember(newUser[0].id, tenantId);
  }

  for (const action of postRegisterActions) {
    await action(newUser[0].id, newUser[0].email, meta);
  }

  return newUser[0];
}

/* ── Pending registration (invitation code required) ──────────────────────
 *
 * When the instance gates sign-ups behind general invitation codes, a social
 * login by an unknown address must not silently create an account: the identity
 * is verified, but nobody has authorised this person to use the instance. The
 * provider round-trip is nevertheless complete and must not be repeated, so the
 * verified profile is parked in a short-lived signed token ("pending
 * registration"). The frontend asks for an invitation code and posts it back
 * together with that token — the second attempt the user asked for.
 *
 * The token carries no privileges of its own: it only proves that *this* server
 * verified *this* identity a few minutes ago. Creating the account still
 * requires a valid invitation code.
 */

const PENDING_REGISTRATION_PURPOSE = "oauth_pending_registration";

/** Cookie holding the pending registration. */
export const OAUTH_PENDING_REGISTRATION_COOKIE = "oauth_pending_registration";

/** How long the user has to produce an invitation code. */
export const OAUTH_PENDING_REGISTRATION_TTL_SECONDS = 15 * 60;

const getPendingRegistrationKey = () => process.env.JWT_PRIVATE_KEY || "";

export type OAuthPendingRegistration = {
  profile: OAuthProfile;
  /** Where to send the user after the account was created. */
  redirect: string;
};

/** Sign the verified profile into a short-lived token. */
export const createPendingRegistrationToken = (
  registration: OAuthPendingRegistration
): string =>
  jwt.sign(
    {
      purpose: PENDING_REGISTRATION_PURPOSE,
      profile: registration.profile,
      redirect: registration.redirect,
    },
    getPendingRegistrationKey(),
    { expiresIn: OAUTH_PENDING_REGISTRATION_TTL_SECONDS }
  );

/**
 * Counterpart of `createPendingRegistrationToken`. Throws for anything that is
 * not a currently valid pending registration — an expired token, a token of
 * another purpose (a session JWT, an invitation token, …) or a forged one.
 */
export const verifyPendingRegistrationToken = (
  token: string
): OAuthPendingRegistration => {
  const decoded = jwt.verify(token, getPendingRegistrationKey()) as
    | {
        purpose?: string;
        profile?: OAuthProfile;
        redirect?: string;
      }
    | string;

  if (
    !decoded ||
    typeof decoded === "string" ||
    decoded.purpose !== PENDING_REGISTRATION_PURPOSE ||
    !decoded.profile?.email ||
    !decoded.profile?.id ||
    !isOAuthProvider(decoded.profile?.provider ?? "")
  ) {
    throw new Error("Invalid pending registration token");
  }

  return {
    profile: decoded.profile,
    redirect: sanitizeOAuthRedirect(decoded.redirect, "/"),
  };
};

/**
 * Does this address need a general invitation code before an account may be
 * created for it? A pending tenant invitation counts as authorisation on its
 * own — same rule as the magic-link sign-up.
 */
const needsInvitationCodeToRegister = async (email: string) => {
  const { invitedInTenantIds } = await getPendingInvitationsForEmail(email);
  if (invitedInTenantIds.length > 0) return false;
  return await checkIfInvitationCodeIsNeededToRegister();
};

/**
 * Second attempt of a social sign-up: the user has come back with an invitation
 * code. The identity is taken from the pending-registration token (never from
 * the request body — the client must not be able to name the account it gets).
 *
 * Races are handled by re-resolving the account first: if the same person
 * finished a sign-up in another tab meanwhile, they are simply logged in.
 */
export const completePendingOAuthRegistration = async (
  pendingRegistrationToken: string,
  invitationCode: string | undefined
) => {
  const { profile, redirect } = verifyPendingRegistrationToken(
    pendingRegistrationToken
  );

  const existing = await findOAuthUser(profile);
  if (existing) {
    const { token, expiresAt } = await generateUserSessionJwt(existing);
    return { token, expiresAt, user: existing, redirect };
  }

  const email = normalizeEmail(profile.email);

  // The gate may have been lifted in the meantime (last code deactivated, or an
  // invitation for this address created) — then no code is demanded any more.
  let setTenantId: string | null = null;
  if (await needsInvitationCodeToRegister(email)) {
    // `checkGeneralInvitationCode` throws a string for a missing / unknown
    // code; normalise it so callers only have to deal with Errors.
    try {
      setTenantId = (await checkGeneralInvitationCode(invitationCode))
        .setTenantId;
    } catch (err) {
      throw new Error(typeof err === "string" ? err : String(err));
    }
  }

  const user = await createOAuthUser(profile, setTenantId, { invitationCode });
  const { token, expiresAt } = await generateUserSessionJwt(user);

  return { token, expiresAt, user, redirect };
};

/* ── Provider calls ──────────────────────────────────────────────────────── */

/** Exchange the authorization code for an access token. */
async function exchangeCodeForToken(
  provider: OAuthProvider,
  code: string,
  codeVerifier?: string
): Promise<string> {
  const { clientId, clientSecret } = credentials(provider);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: getOAuthRedirectUri(provider),
  });
  if (codeVerifier) body.set("code_verifier", codeVerifier);

  const response = await fetch(endpoints(provider).token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || payload.error || !payload.access_token) {
    throw new Error(
      `${provider} token exchange failed: ${
        payload.error ?? response.status
      } ${payload.error_description ?? ""}`.trim()
    );
  }

  return payload.access_token;
}

/** Read the signed-in identity from the provider. */
async function fetchOAuthProfile(
  provider: OAuthProvider,
  accessToken: string
): Promise<OAuthProfile> {
  const url =
    provider === "google"
      ? "https://www.googleapis.com/oauth2/v3/userinfo"
      : "https://graph.microsoft.com/v1.0/me";

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const info = (await response.json().catch(() => ({}))) as any;

  if (!response.ok || info.error) {
    const message =
      typeof info.error === "string"
        ? `${info.error} ${info.error_description ?? ""}`
        : (info.error?.message ?? response.status);
    throw new Error(`${provider} profile request failed: ${message}`);
  }

  // Work/school accounts may carry the address only as userPrincipalName.
  const email = String(
    provider === "google" ? info.email : info.mail || info.userPrincipalName
  )
    .trim()
    .toLowerCase();

  if (!email.includes("@")) {
    throw new Error(`${provider} account has no usable e-mail address`);
  }

  // The provider's stable subject id: Microsoft's `oid`, Google's `sub`. It is
  // the primary key of the identity, so a response without one is refused
  // rather than stored as the string "undefined".
  const id = String(
    (provider === "google" ? info.sub : info.id) ?? ""
  ).trim();

  if (id === "") {
    throw new Error(`${provider} profile has no subject id`);
  }

  return {
    email,
    id,
    provider,
    firstname: (provider === "google" ? info.given_name : info.givenName) ?? "",
    surname: (provider === "google" ? info.family_name : info.surname) ?? "",
  };
}

/**
 * Outcome of a social login callback.
 *
 * `invitation_code_required` is not an error: the identity is verified, the
 * instance simply gates sign-ups behind an invitation code and this address has
 * none. The caller is expected to ask for a code and hand it, together with
 * `pendingRegistrationToken`, to `completePendingOAuthRegistration`.
 */
export type OAuthCallbackResult =
  | {
      status: "authenticated";
      token: string;
      expiresAt: Awaited<ReturnType<typeof generateUserSessionJwt>>["expiresAt"];
      user: NonNullable<Awaited<ReturnType<typeof findOAuthUser>>>;
    }
  | {
      status: "invitation_code_required";
      pendingRegistrationToken: string;
      email: string;
      provider: OAuthProvider;
    };

export const OAuthAuth = {
  /**
   * Finish a login: code → access token → profile → framework session.
   * The returned token is a normal, revocable user session JWT.
   *
   * When the account does not exist yet and the instance requires an invitation
   * code, **no account is created**. The verified identity is returned as a
   * pending registration instead, see `OAuthCallbackResult`.
   */
  async handleCallback(
    provider: OAuthProvider,
    code: string,
    codeVerifier?: string,
    /** Where to send the user once the account exists (kept in the token). */
    redirect = "/"
  ): Promise<OAuthCallbackResult> {
    const accessToken = await exchangeCodeForToken(provider, code, codeVerifier);
    const profile = await fetchOAuthProfile(provider, accessToken);

    const existing = await findOAuthUser(profile);

    if (!existing) {
      const email = normalizeEmail(profile.email);

      if (await needsInvitationCodeToRegister(email)) {
        log.info(
          `${provider} login by unknown address ${email}: invitation code required before an account is created`
        );
        return {
          status: "invitation_code_required",
          pendingRegistrationToken: createPendingRegistrationToken({
            profile,
            redirect,
          }),
          email,
          provider,
        };
      }
    }

    const user = existing ?? (await createOAuthUser(profile));
    if (!user) {
      throw new Error("Failed to find or create user");
    }

    const { token, expiresAt } = await generateUserSessionJwt(user);

    return { status: "authenticated", token, expiresAt, user };
  },

  /** Backwards-compatible wrappers around `handleCallback`. */
  async handleGoogleCallback(code: string, codeVerifier?: string) {
    return this.handleCallback("google", code, codeVerifier);
  },

  async handleMicrosoftCallback(code: string, codeVerifier?: string) {
    return this.handleCallback("microsoft", code, codeVerifier);
  },

  /** URL the browser is sent to in order to pick an account. */
  getAuthUrl(
    provider: OAuthProvider,
    options?: { state?: string; codeChallenge?: string }
  ) {
    const { clientId } = credentials(provider);
    const { authorize, scope } = endpoints(provider);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: getOAuthRedirectUri(provider),
      response_type: "code",
      response_mode: "query",
      scope,
    });

    if (provider === "google") {
      // A refresh token is not needed: the framework issues its own session.
      params.delete("response_mode");
      params.set("prompt", "select_account");
    }

    if (options?.state) params.set("state", options.state);
    if (options?.codeChallenge) {
      params.set("code_challenge", options.codeChallenge);
      params.set("code_challenge_method", "S256");
    }

    return `${authorize}?${params.toString()}`;
  },

  getGoogleAuthUrl(options?: { state?: string; codeChallenge?: string }) {
    return this.getAuthUrl("google", options);
  },

  getMicrosoftAuthUrl(options?: { state?: string; codeChallenge?: string }) {
    return this.getAuthUrl("microsoft", options);
  },

  getAvailableOAuthProviders() {
    return {
      google: isOAuthProviderActive("google"),
      microsoft: isOAuthProviderActive("microsoft"),
    };
  },
};
