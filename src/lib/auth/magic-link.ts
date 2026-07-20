import { and, eq, gt, lt, sql } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  magicLinkSessions,
  users,
  type UserSelectBasic,
} from "../db/db-schema";
import { nanoid } from "nanoid";
import { smtpService } from "../email";
import { generateUserSessionJwt } from ".";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { postRegisterActions } from "./actions";
import { checkIfInvitationCodeIsNeededToRegister, getPendingInvitationsForEmail } from "../usermanagement/invitations";
import { checkGeneralInvitationCode } from "./index";

const EXPIRE_TIME = 15 * 60 * 1000; // 15 minutes

/**
 * How often a single login / email-verification token may be redeemed within
 * its TTL. Magic-link tokens are intentionally NOT strictly single-use:
 * corporate e-mail security scanners (Microsoft Safe Links, Proofpoint,
 * Mimecast, Barracuda, …) pre-open links in a JS-capable sandbox and thereby
 * auto-fire the login request. A strict single-use token would already be
 * consumed by that scanner before the human ever clicks the link, producing a
 * spurious "invalid token" error. Allowing a small number of redemptions lets
 * both the scanner and the real user succeed, while the cap keeps replay abuse
 * bounded. The short TTL remains the primary safeguard.
 */
const MAX_REDEMPTIONS = 5;

/**
 * Create a Magic Link Token
 */
export const createMagicLinkToken = async (
  email: string,
  purpose: "login" | "email_verification" | "password_reset",
  createUserIfMissing: boolean = false,
  invitationCode?: string,
  customRegisterData?: Record<string, any>,
  firstname?: string,
  surname?: string
): Promise<string> => {
  // Check if user exists
  let userResult = await getDb()
    .select({
      id: users.id,
      email: users.email,
      firstname: users.firstname,
      surname: users.surname,
    })
    .from(users)
    .where(eq(users.email, email));

  const isNewUser = !userResult[0];

  // If creating a new user, check invitation code requirements
  if (isNewUser && createUserIfMissing) {
    // Check if invitation codes are required
    const invitationCodeNeeded = await checkIfInvitationCodeIsNeededToRegister();
    
    if (invitationCodeNeeded) {
      // Check if user has pending invitations
      const { invitedInTenantIds } = await getPendingInvitationsForEmail(email);
      
      // If no pending invitations, require invitation code
      if (invitedInTenantIds.length < 1) {
        if (!invitationCode) {
          throw new Error("Invitation code needed");
        }
        
        // Validate the invitation code
        try {
          await checkGeneralInvitationCode(invitationCode);
        } catch (error) {
          throw new Error("Invitation code not found");
        }
      }
    }

    // Create the user – persist customRegisterData (if any) in the meta column
    const metaToPersist =
      customRegisterData && typeof customRegisterData === "object"
        ? { customRegisterData }
        : null;

    const newUser = await getDb()
      .insert(users)
      .values({
        email: email,
        firstname: firstname ?? "",
        surname: surname ?? "",
        extUserId: "",
        salt: "",
        password: null,
        emailVerified: false,
        meta: metaToPersist,
      })
      .onConflictDoNothing()
      .returning({
        id: users.id,
        email: users.email,
        firstname: users.firstname,
        surname: users.surname,
      });

    if (!newUser[0]) {
      throw new Error("Failed to create user");
    }
    userResult = newUser;

    // Execute post-register actions for newly created user. The register meta
    // (invitation code + custom data) is forwarded so custom hooks can react
    // to per-user registration context (e.g. auto-assign to a sub-entity).
    const registerMeta = {
      invitationCode,
      customRegisterData,
    };
    for (const action of postRegisterActions) {
      await action(newUser[0].id, newUser[0].email, registerMeta);
    }
  }

  if (!userResult[0]) {
    throw new Error("User not found");
  }
  const user = userResult[0];

  // Opportunistically prune expired tokens for this user. Since tokens are no
  // longer deleted on first use (they stay redeemable within their TTL), this
  // keeps the table from growing unbounded without needing a background job.
  await getDb()
    .delete(magicLinkSessions)
    .where(
      and(
        eq(magicLinkSessions.userId, user.id),
        lt(magicLinkSessions.expiresAt, new Date().toISOString())
      )
    );

  // Generate a unique token
  const token = nanoid(32);
  const expiresAt = new Date(Date.now() + EXPIRE_TIME); // token expires after 15 minutes

  // Store the token in the database
  await getDb().insert(magicLinkSessions).values({
    userId: user.id,
    token,
    expiresAt: expiresAt.toISOString(),
    purpose,
  });

  return token;
};

/**
 * Create a Magic Login Link
 * @param email
 * @param redirectUrl
 * @param createUserIfMissing
 * @param invitationCode
 */
export const createMagicLoginLink = async (
  email: string,
  redirectUrl?: string,
  createUserIfMissing: boolean = false,
  invitationCode?: string,
  customRegisterData?: Record<string, any>,
  firstname?: string,
  surname?: string
): Promise<string> => {
  const token = await createMagicLinkToken(
    email,
    "login",
    createUserIfMissing,
    invitationCode,
    customRegisterData,
    firstname,
    surname
  );
  const magicLink = `${_GLOBAL_SERVER_CONFIG.baseUrl}${_GLOBAL_SERVER_CONFIG.magicLoginVerifyUrl}?token=${encodeURIComponent(token)}${
    redirectUrl ? `&redirectUrl=${encodeURIComponent(redirectUrl)}` : ""
  }`;

  return magicLink;
};

/**
 * Send Magic Link to the users Email address
 *
 * @param template Optional key of a custom template defined via
 *   `emailTemplates.custom` in the server config. Falls back to the default
 *   `magicLink` template when the key is missing or not registered.
 */
export const sendMagicLink = async (
  email: string,
  redirectUrl?: string,
  createUserIfMissing: boolean = false,
  invitationCode?: string,
  customRegisterData?: Record<string, any>,
  template?: string,
  firstname?: string,
  surname?: string
): Promise<void> => {
  const magicLink = await createMagicLoginLink(
    email,
    redirectUrl,
    createUserIfMissing,
    invitationCode,
    customRegisterData,
    firstname,
    surname
  );

  const customTemplate = template
    ? _GLOBAL_SERVER_CONFIG.emailTemplates.custom?.[template]
    : undefined;
  const templateFn =
    customTemplate ?? _GLOBAL_SERVER_CONFIG.emailTemplates.magicLink;

  const { html, subject } = await templateFn({
    appName: _GLOBAL_SERVER_CONFIG.appName,
    logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
    baseUrl: _GLOBAL_SERVER_CONFIG.baseUrl,
    link: magicLink,
  });

  // The magic-link token is already persisted at this point, so the actual
  // SMTP dispatch is decoupled from the request: the caller (e.g. the login
  // POST handler) returns immediately instead of blocking on the SMTP
  // round-trip (which can retry for up to ~30 minutes on failure).
  smtpService.sendMailInBackground({
    sender: process.env.SMTP_FROM,
    recipients: [email],
    subject,
    html,
  });
};

/**
 * Send Verification Email to the users Email address
 */
export const sendVerificationEmail = async (email: string) => {
  // Create a token
  const token = await createMagicLinkToken(email, "email_verification");

  // Construct the magic link URL
  const magicLink = `${_GLOBAL_SERVER_CONFIG.baseUrl}${_GLOBAL_SERVER_CONFIG.verifyEmailUrl}?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

  const { html, subject } =
    await _GLOBAL_SERVER_CONFIG.emailTemplates.verifyEmail({
      appName: _GLOBAL_SERVER_CONFIG.appName,
      logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
      baseUrl: _GLOBAL_SERVER_CONFIG.baseUrl,
      link: magicLink,
    });

  await smtpService.sendMail({
    sender: process.env.SMTP_FROM,
    recipients: [email],
    subject,
    html,
  });
};

/**
 * Verify Email Token
 */
export const verifyEmailToken = async (token: string) => {
  // Find the magic link record. Compare against the current time directly:
  // `expiresAt` is already stored as `createdAt + EXPIRE_TIME`, so subtracting
  // EXPIRE_TIME again here would double the effective validity window.
  const now = new Date().toISOString();
  const magicLinkResult = await getDb()
    .select()
    .from(magicLinkSessions)
    .where(
      and(
        eq(magicLinkSessions.token, token),
        gt(magicLinkSessions.expiresAt, now)
      )
    );

  if (!magicLinkResult[0]) {
    throw new Error("Invalid or expired magic link");
  }

  // Reject once the redemption cap is exhausted (see MAX_REDEMPTIONS).
  if (magicLinkResult[0].usedCount >= MAX_REDEMPTIONS) {
    throw new Error("Invalid or expired magic link");
  }
  const userId = magicLinkResult[0].userId;

  const user = await getDb()
    .select({
      id: users.id,
      email: users.email,
      firstname: users.firstname,
      surname: users.surname,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user[0]) {
    throw new Error("User not found");
  }

  if (!user[0].emailVerified) {
    await getDb()
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, userId));
  }

  return {
    user: user[0],
    tokenId: magicLinkResult[0].id,
    usedCount: magicLinkResult[0].usedCount,
  };
};

/**
 * Delete Magic Link Token
 */
export const deleteMagicLinkToken = async (tokenId: string) => {
  await getDb()
    .delete(magicLinkSessions)
    .where(eq(magicLinkSessions.id, tokenId));
};

/**
 * Redeem a Magic Link Token.
 *
 * Instead of deleting the token on first use, we increment its redemption
 * counter so it stays valid for repeated redemptions within its TTL (see
 * MAX_REDEMPTIONS for the rationale). Once the final allowed redemption is
 * reached the row is deleted, which also keeps the table tidy.
 */
export const redeemMagicLinkToken = async (
  tokenId: string,
  currentUsedCount: number
) => {
  if (currentUsedCount + 1 >= MAX_REDEMPTIONS) {
    // Last allowed redemption – remove the token entirely.
    await deleteMagicLinkToken(tokenId);
    return;
  }
  await getDb()
    .update(magicLinkSessions)
    .set({ usedCount: sql`${magicLinkSessions.usedCount} + 1` })
    .where(eq(magicLinkSessions.id, tokenId));
};

/**
 * Verify Magic Link Token and Authenticate User
 */
export const verifyMagicLink = async (
  token: string
): Promise<{ user: UserSelectBasic; token: string }> => {
  // Verify the email token
  const { user, tokenId, usedCount } = await verifyEmailToken(token);

  // Generate a session token (JWT) backed by a server-side session
  const { token: sessionToken } = await generateUserSessionJwt(user);
  // Count this redemption instead of deleting the token, so a link pre-opened
  // by an e-mail security scanner does not lock the real user out.
  await redeemMagicLinkToken(tokenId, usedCount);

  return { user, token: sessionToken };
};

/**
 * Verify Magic Link Token and Authenticate User
 */
export const verifyEmail = async (
  token: string
): Promise<{ user: UserSelectBasic; token: string }> => {
  // Verify the email token
  const { user, tokenId, usedCount } = await verifyEmailToken(token);

  // Update the user's emailVerified status
  await getDb()
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, user.id));

  // Generate a session token (JWT) backed by a server-side session
  const { token: sessionToken } = await generateUserSessionJwt(user);
  // See verifyMagicLink: redeem (count) rather than hard-delete on first use.
  await redeemMagicLinkToken(tokenId, usedCount);

  return { user, token: sessionToken };
};

/**
 * Creates a reset password link for the user
 */
export const createResetPasswordLink = async (
  email: string
): Promise<string> => {
  const token = await createMagicLinkToken(email, "password_reset");
  const resetLink = `${_GLOBAL_SERVER_CONFIG.baseUrl}${_GLOBAL_SERVER_CONFIG.resetPasswordUrl}?token=${encodeURIComponent(token)}`;
  return resetLink;
};

/**
 * Send a Reset Password Email
 */
export const sendResetPasswordLink = async (
  email: string,
  sendWelcomeText = false
): Promise<void> => {
  const resetLink = await createResetPasswordLink(email);

  let html: string;
  let subject: string;

  if (sendWelcomeText) {
    const welcomeMail =
      await _GLOBAL_SERVER_CONFIG.emailTemplates.resetPasswordWelcome({
        appName: _GLOBAL_SERVER_CONFIG.appName,
        logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
        baseUrl: _GLOBAL_SERVER_CONFIG.baseUrl,
        link: resetLink,
      });
    html = welcomeMail.html;
    subject = welcomeMail.subject;
  } else {
    const resetMail = await _GLOBAL_SERVER_CONFIG.emailTemplates.resetPassword({
      appName: _GLOBAL_SERVER_CONFIG.appName,
      logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
      baseUrl: _GLOBAL_SERVER_CONFIG.baseUrl,
      link: resetLink,
    });
    html = resetMail.html;
    subject = resetMail.subject;
  }

  await smtpService.sendMail({
    sender: process.env.SMTP_FROM,
    recipients: [email],
    subject,
    html,
  });
};

/**
 * Verify a Password Reset Token
 */
export const verifyPasswordResetToken = async (
  token: string
): Promise<{ userId: string }> => {
  // Compare against the current time directly (see verifyEmailToken): the
  // previous `now - EXPIRE_TIME` offset doubled the effective validity window.
  const now = new Date().toISOString();
  const magicLinkResult = await getDb()
    .select()
    .from(magicLinkSessions)
    .where(
      and(
        eq(magicLinkSessions.token, token),
        eq(magicLinkSessions.purpose, "password_reset"),
        gt(magicLinkSessions.expiresAt, now)
      )
    );

  if (!magicLinkResult[0]) {
    throw new Error("Invalid or expired password reset token");
  }

  // Token is valid - delete it immediately, so it cannot be reused. The reset
  // link is NOT auto-fired on page load (the user must submit a new password),
  // so it is safe to keep this flow strictly single-use.
  await deleteMagicLinkToken(magicLinkResult[0].id);

  return { userId: magicLinkResult[0].userId };
};
