/**
 * Passwordless email login codes (OTP).
 *
 * Used by the OAuth authorize flow's "not logged in" path: a 6-digit code is
 * sent by email and entered in the SAME browser window (a magic *link* would
 * open a new context and break the flow's state/PKCE).
 *
 * Security:
 *  - Only the SHA-256 hash of the code is stored, never the plaintext.
 *  - Single active code per (email, purpose): creating a new one invalidates
 *    older unconsumed codes.
 *  - Single-use, short TTL, capped attempts (config: oauth2.emailLoginCode*).
 *  - `sendEmailLoginCode` only sends to existing users but never reveals whether
 *    the address exists (no user enumeration).
 *
 * This module only manages the code lifecycle. Session creation after a
 * successful verification is the caller's responsibility (OAuth authorize).
 */
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import * as crypto from "crypto";
import { getDb } from "../db/db-connection";
import { emailLoginCodes, users } from "../db/db-schema";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { smtpService } from "../email";

export type EmailOtpPurpose = "oauth_login";

const DEFAULT_TTL_SECONDS = 60 * 10;
const DEFAULT_MAX_ATTEMPTS = 5;

const ttlSeconds = () =>
  _GLOBAL_SERVER_CONFIG.oauth2?.emailLoginCodeTtl ?? DEFAULT_TTL_SECONDS;
const maxAttempts = () =>
  _GLOBAL_SERVER_CONFIG.oauth2?.emailLoginCodeMaxAttempts ??
  DEFAULT_MAX_ATTEMPTS;

const hashCode = (code: string): string =>
  crypto.createHash("sha256").update(code).digest("hex");

/** Cryptographically secure 6-digit numeric code (leading zeros kept). */
const generateCode = (): string =>
  crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Create a login code for an email and return the plaintext code (for sending).
 * Invalidates any previous unconsumed code for the same (email, purpose).
 */
export const createEmailLoginCode = async (
  email: string,
  purpose: EmailOtpPurpose = "oauth_login"
): Promise<string> => {
  const normalized = normalizeEmail(email);

  // Invalidate older unconsumed codes so only one is ever active.
  await getDb()
    .delete(emailLoginCodes)
    .where(
      and(
        eq(emailLoginCodes.email, normalized),
        eq(emailLoginCodes.purpose, purpose),
        isNull(emailLoginCodes.consumedAt)
      )
    );

  const code = generateCode();
  const expiresAt = new Date(Date.now() + ttlSeconds() * 1000).toISOString();

  await getDb().insert(emailLoginCodes).values({
    email: normalized,
    codeHash: hashCode(code),
    purpose,
    expiresAt,
  });

  return code;
};

/**
 * Send a login code by email. Only sends to existing users, but always resolves
 * void regardless of whether the address exists (no enumeration leak).
 */
export const sendEmailLoginCode = async (
  email: string,
  purpose: EmailOtpPurpose = "oauth_login"
): Promise<void> => {
  const normalized = normalizeEmail(email);

  const existing = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized));
  if (!existing[0]) {
    // Do not reveal that the account does not exist.
    return;
  }

  const code = await createEmailLoginCode(normalized, purpose);

  const templateFn =
    _GLOBAL_SERVER_CONFIG.emailTemplates.emailLoginCode ??
    _GLOBAL_SERVER_CONFIG.emailTemplates.magicLink;

  const { html, subject } = await templateFn({
    appName: _GLOBAL_SERVER_CONFIG.appName,
    logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
    baseUrl: _GLOBAL_SERVER_CONFIG.baseUrl,
    code,
  });

  await smtpService.sendMail({
    sender: process.env.SMTP_FROM,
    recipients: [normalized],
    subject,
    html,
  });
};

/**
 * Verify a login code. On success the code is consumed (single-use) and the
 * matching user is returned. Throws on invalid / expired / too-many-attempts.
 */
export const verifyEmailLoginCode = async (
  email: string,
  code: string,
  purpose: EmailOtpPurpose = "oauth_login"
): Promise<{ userId: string; email: string }> => {
  const normalized = normalizeEmail(email);

  // Fetch the latest still-valid (unconsumed AND unexpired) code. Expiry is
  // compared in SQL against an ISO string — the same representation used at
  // insert time — to avoid the timezone trap of parsing a naive `timestamp`
  // string with `new Date()` in JS.
  const rows = await getDb()
    .select()
    .from(emailLoginCodes)
    .where(
      and(
        eq(emailLoginCodes.email, normalized),
        eq(emailLoginCodes.purpose, purpose),
        isNull(emailLoginCodes.consumedAt),
        gt(emailLoginCodes.expiresAt, new Date().toISOString())
      )
    )
    .orderBy(desc(emailLoginCodes.createdAt));
  const row = rows[0];
  if (!row) {
    throw new Error("Invalid or expired code");
  }

  // Too many attempts already → invalidate and reject.
  if (row.attempts >= maxAttempts()) {
    await consume(row.id);
    throw new Error("Too many attempts");
  }

  if (hashCode(code) !== row.codeHash) {
    const nextAttempts = row.attempts + 1;
    if (nextAttempts >= maxAttempts()) {
      // Final wrong attempt → burn the code.
      await consume(row.id);
    } else {
      await getDb()
        .update(emailLoginCodes)
        .set({ attempts: nextAttempts })
        .where(eq(emailLoginCodes.id, row.id));
    }
    throw new Error("Invalid code");
  }

  // Correct → consume (single-use).
  await consume(row.id);

  const user = await getDb()
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, normalized));
  if (!user[0]) {
    throw new Error("User not found");
  }

  return { userId: user[0].id, email: user[0].email };
};

const consume = async (id: string) => {
  await getDb()
    .update(emailLoginCodes)
    .set({ consumedAt: new Date().toISOString() })
    .where(eq(emailLoginCodes.id, id));
};
