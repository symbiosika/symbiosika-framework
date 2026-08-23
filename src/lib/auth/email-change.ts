/**
 * Changing the e-mail address of an existing account.
 *
 * The address is a user's identity in this framework (login, invitations,
 * password reset all key on it), so it is never written straight from an API
 * call. The flow is:
 *
 *   1. `requestEmailChange` – the logged-in user asks for a new address. The
 *      request is parked in `email_change_requests`; `users.email` is
 *      untouched. A confirmation link goes to the NEW address, and a heads-up
 *      mail (no link) to the OLD one so a hijacked session cannot silently
 *      take the account over.
 *   2. `confirmEmailChange` – possession of the token from the new mailbox is
 *      the proof that the address exists and belongs to the requester. Only
 *      now is `users.email` updated (and `emailVerified` set, since the
 *      address was just proven).
 *
 * Notes on the design:
 *  - Only the SHA-256 hash of the token is stored (see the schema file).
 *  - One open request per user: creating a new one drops the previous.
 *  - Strictly single-use, unlike magic-link tokens. The confirmation is a
 *    POST triggered by an explicit click on the confirmation page, so the
 *    e-mail security scanners that pre-open links (Safe Links, Proofpoint, …)
 *    do not burn the token — and the address is not switched behind the
 *    user's back by a scanner.
 *  - Availability of the target address is checked twice: when requesting
 *    (fast feedback) and again when confirming (two users may race for the
 *    same address; the first to confirm wins).
 */
import { and, eq, gt, isNull, lt, ne } from "drizzle-orm";
import * as crypto from "crypto";
import { nanoid } from "nanoid";
import { getDb } from "../db/db-connection";
import { emailChangeRequests, users } from "../db/db-schema";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { smtpService } from "../email";
import { normalizeEmail } from "../utils/email";
import log from "../log";

const DEFAULT_TTL_SECONDS = 60 * 60;

/**
 * Minimum distance between two confirmation mails for the SAME target address.
 * The endpoint mails an address the requester types in, so without a cooldown
 * an authenticated user could use it to flood someone else's mailbox.
 */
const RESEND_COOLDOWN_SECONDS = 60;

const ttlSeconds = () =>
  _GLOBAL_SERVER_CONFIG.emailChangeTtl ?? DEFAULT_TTL_SECONDS;

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

/** Minimal sanity check – the real proof is that the mail is received. */
const looksLikeEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export type EmailChangeRequestInfo = {
  id: string;
  newEmail: string;
  oldEmail: string;
  expiresAt: string;
  createdAt: string;
};

/**
 * Build the confirmation link that is mailed to the new address.
 */
export const buildEmailChangeConfirmLink = (token: string): string =>
  `${_GLOBAL_SERVER_CONFIG.baseUrl}${_GLOBAL_SERVER_CONFIG.verifyEmailChangeUrl}?token=${encodeURIComponent(token)}`;

/**
 * Remove the user's expired requests — including consumed ones, which is what
 * eventually clears the audit trail of a completed change. Keeps the table
 * tidy without a background job (same approach as the magic-link cleanup).
 */
const pruneStaleRequests = async (userId: string) => {
  const now = new Date().toISOString();
  await getDb()
    .delete(emailChangeRequests)
    .where(
      and(
        eq(emailChangeRequests.userId, userId),
        lt(emailChangeRequests.expiresAt, now)
      )
    );
};

/**
 * The user's open (unconsumed, unexpired) e-mail change request, if any.
 */
export const getPendingEmailChangeRequest = async (
  userId: string
): Promise<EmailChangeRequestInfo | null> => {
  // Expiry is compared in SQL (see findValidRequestRow): a `timestamp` column
  // read back as a string is not lexicographically comparable to an ISO string
  // in JS ("2026-01-01 10:00" vs "2026-01-01T09:00").
  const now = new Date().toISOString();
  const rows = await getDb()
    .select()
    .from(emailChangeRequests)
    .where(
      and(
        eq(emailChangeRequests.userId, userId),
        isNull(emailChangeRequests.consumedAt),
        gt(emailChangeRequests.expiresAt, now)
      )
    );

  const open = rows[0];
  if (!open) {
    return null;
  }
  return {
    id: open.id,
    newEmail: open.newEmail,
    oldEmail: open.oldEmail,
    expiresAt: open.expiresAt,
    createdAt: open.createdAt,
  };
};

/**
 * Drop every open request of a user. Returns how many were removed so a route
 * can answer "nothing to cancel".
 */
export const cancelEmailChangeRequest = async (
  userId: string
): Promise<number> => {
  const deleted = await getDb()
    .delete(emailChangeRequests)
    .where(
      and(
        eq(emailChangeRequests.userId, userId),
        isNull(emailChangeRequests.consumedAt)
      )
    )
    .returning({ id: emailChangeRequests.id });
  return deleted.length;
};

/**
 * Is this address free (not owned by another account)?
 */
const isEmailTaken = async (
  normalizedEmail: string,
  exceptUserId: string
): Promise<boolean> => {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, normalizedEmail), ne(users.id, exceptUserId)));
  return rows.length > 0;
};

/**
 * Start an e-mail change for a logged-in user.
 *
 * Throws (plain `Error`, message is safe to show) when the address is
 * malformed, unchanged or already in use. On success the confirmation mail is
 * on its way to the new address and the old address has been notified.
 *
 * @param sendMails set to false to only create the request (used by tests and
 *   by callers that want to dispatch the mail themselves)
 * @returns the created request plus the plaintext token (the token is only
 *   ever returned here, never stored in plaintext)
 */
export const requestEmailChange = async (
  userId: string,
  rawNewEmail: string,
  sendMails: boolean = true
): Promise<EmailChangeRequestInfo & { token: string }> => {
  const newEmail = normalizeEmail(rawNewEmail);

  if (!looksLikeEmail(newEmail)) {
    throw new Error("Invalid email address");
  }

  const userRows = await getDb()
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  const user = userRows[0];
  if (!user) {
    throw new Error("User not found");
  }

  if (normalizeEmail(user.email) === newEmail) {
    throw new Error("The new email address is the current one");
  }

  if (await isEmailTaken(newEmail, userId)) {
    throw new Error("This email address is already in use");
  }

  await pruneStaleRequests(userId);

  // Timestamps are compared in SQL throughout this module (see
  // findValidRequestRow for why a JS string compare is wrong here).
  const cooldownCutoff = new Date(
    Date.now() - RESEND_COOLDOWN_SECONDS * 1000
  ).toISOString();
  const recent = await getDb()
    .select({ id: emailChangeRequests.id })
    .from(emailChangeRequests)
    .where(
      and(
        eq(emailChangeRequests.userId, userId),
        eq(emailChangeRequests.newEmail, newEmail),
        isNull(emailChangeRequests.consumedAt),
        gt(emailChangeRequests.createdAt, cooldownCutoff)
      )
    );
  if (recent.length > 0) {
    throw new Error(
      "A confirmation email for this address was just sent. Please try again in a minute"
    );
  }

  // Only one open request per user: a second one supersedes the first, so a
  // link that was mailed earlier stops working.
  await getDb()
    .delete(emailChangeRequests)
    .where(
      and(
        eq(emailChangeRequests.userId, userId),
        isNull(emailChangeRequests.consumedAt)
      )
    );

  const token = nanoid(48);
  const expiresAt = new Date(Date.now() + ttlSeconds() * 1000).toISOString();

  const inserted = await getDb()
    .insert(emailChangeRequests)
    .values({
      userId,
      newEmail,
      oldEmail: normalizeEmail(user.email),
      tokenHash: hashToken(token),
      expiresAt,
    })
    .returning();

  const request = inserted[0];
  if (!request) {
    throw new Error("Failed to create the email change request");
  }

  if (sendMails) {
    await sendEmailChangeMails({
      token,
      newEmail,
      oldEmail: normalizeEmail(user.email),
    });
  }

  return {
    id: request.id,
    newEmail: request.newEmail,
    oldEmail: request.oldEmail,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
    token,
  };
};

/**
 * Send both mails of the flow: the confirmation link to the new address and
 * the informational notice to the old one.
 *
 * Dispatch is decoupled from the request (`sendMailInBackground`): the row is
 * already persisted, so the API call must not block on an SMTP round-trip
 * that can retry for ~30 minutes.
 */
const sendEmailChangeMails = async (data: {
  token: string;
  newEmail: string;
  oldEmail: string;
}) => {
  const link = buildEmailChangeConfirmLink(data.token);
  const base = {
    appName: _GLOBAL_SERVER_CONFIG.appName,
    logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
    baseUrl: _GLOBAL_SERVER_CONFIG.baseUrl,
    newEmail: data.newEmail,
    oldEmail: data.oldEmail,
  };

  const verifyTemplate =
    _GLOBAL_SERVER_CONFIG.emailTemplates.verifyEmailChange ??
    _GLOBAL_SERVER_CONFIG.emailTemplates.verifyEmail;
  const confirmation = await verifyTemplate({ ...base, link });
  smtpService.sendMailInBackground({
    sender: process.env.SMTP_FROM,
    recipients: [data.newEmail],
    subject: confirmation.subject,
    html: confirmation.html,
  });

  // The heads-up to the still-active address is best effort: it must never
  // fail the request itself.
  try {
    const noticeTemplate =
      _GLOBAL_SERVER_CONFIG.emailTemplates.emailChangeNotice;
    if (noticeTemplate) {
      const notice = await noticeTemplate(base);
      smtpService.sendMailInBackground({
        sender: process.env.SMTP_FROM,
        recipients: [data.oldEmail],
        subject: notice.subject,
        html: notice.html,
      });
    }
  } catch (err) {
    log.error("Error sending email change notice to the old address: " + err);
  }
};

/**
 * Internal: the open, unexpired request row for a plaintext token.
 * Throws when the token is unknown, expired or already consumed.
 */
const findValidRequestRow = async (token: string) => {
  // The expiry check runs in SQL on purpose. `expiresAt` comes back from a
  // `timestamp` column as "2026-01-01 10:00:00" while `toISOString()` yields
  // "2026-01-01T09:00:00.000Z", so comparing the two as JS strings compares
  // " " against "T" and marks every token expired. Postgres compares them as
  // timestamps.
  const now = new Date().toISOString();
  const rows = await getDb()
    .select()
    .from(emailChangeRequests)
    .where(
      and(
        eq(emailChangeRequests.tokenHash, hashToken(token)),
        isNull(emailChangeRequests.consumedAt),
        gt(emailChangeRequests.expiresAt, now)
      )
    );

  const request = rows[0];
  if (!request) {
    throw new Error("Invalid or expired email change token");
  }
  return request;
};

/**
 * Look a request up by its plaintext token without consuming it. Used by the
 * confirmation page to show *what* is about to be confirmed before the user
 * clicks. Throws when the token is unknown, expired or already used.
 */
export const getEmailChangeRequestByToken = async (
  token: string
): Promise<EmailChangeRequestInfo> => {
  const request = await findValidRequestRow(token);
  return {
    id: request.id,
    newEmail: request.newEmail,
    oldEmail: request.oldEmail,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
  };
};

/**
 * Confirm a pending change: the token proves the new mailbox is reachable, so
 * the address is written to the account and marked verified.
 *
 * Single-use: the request row is consumed and every other open request of the
 * same user is dropped.
 */
export const confirmEmailChange = async (
  token: string
): Promise<{ userId: string; oldEmail: string; newEmail: string }> => {
  const request = await findValidRequestRow(token);

  const userRows = await getDb()
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, request.userId));
  const user = userRows[0];
  if (!user) {
    throw new Error("User not found");
  }

  // The account's address may have moved on since the request was created
  // (another confirmed change, an admin edit). Confirming would then silently
  // revert that newer state, so the stale request is rejected instead.
  if (normalizeEmail(user.email) !== request.oldEmail) {
    await getDb()
      .delete(emailChangeRequests)
      .where(eq(emailChangeRequests.id, request.id));
    throw new Error("Invalid or expired email change token");
  }

  // Re-check availability: two accounts may hold an open request for the same
  // address, and the mailbox may have been claimed since.
  if (await isEmailTaken(request.newEmail, user.id)) {
    throw new Error("This email address is already in use");
  }

  await getDb()
    .update(users)
    .set({
      email: request.newEmail,
      // The user just proved they can read mail at this address.
      emailVerified: true,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(users.id, user.id));

  // Mark this request consumed (single use, and a short-lived record of the
  // change) and drop the user's other open ones – they all point at an address
  // the account no longer has. The consumed row is removed by the next prune
  // once its TTL has passed.
  await getDb()
    .update(emailChangeRequests)
    .set({ consumedAt: new Date().toISOString() })
    .where(eq(emailChangeRequests.id, request.id));
  await getDb()
    .delete(emailChangeRequests)
    .where(
      and(
        eq(emailChangeRequests.userId, user.id),
        isNull(emailChangeRequests.consumedAt)
      )
    );

  log.info(`Email changed for user ${user.id}`);

  return {
    userId: user.id,
    oldEmail: request.oldEmail,
    newEmail: request.newEmail,
  };
};
