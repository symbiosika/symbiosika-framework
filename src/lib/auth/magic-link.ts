import { and, eq, gt } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  magicLinkSessions,
  users,
  type UserSelectBasic,
} from "../db/db-schema";
import { nanoid } from "nanoid";
import { smtpService } from "../email";
import { generateJwt } from ".";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

const EXPIRE_TIME = 15 * 60 * 1000; // 15 minutes

/**
 * Create a Magic Link Token
 */
export const createMagicLinkToken = async (
  email: string,
  purpose: "login" | "email_verification" | "password_reset"
): Promise<string> => {
  // Check if user exists
  const userResult = await getDb()
    .select({
      id: users.id,
      email: users.email,
      firstname: users.firstname,
      surname: users.surname,
    })
    .from(users)
    .where(eq(users.email, email));

  if (userResult.length === 0) {
    throw new Error("User not found");
  }
  const user = userResult[0];

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
 */
export const createMagicLoginLink = async (
  email: string,
  redirectUrl?: string
): Promise<string> => {
  const token = await createMagicLinkToken(email, "login");
  const frontendUrl = _GLOBAL_SERVER_CONFIG.baseUrl || "http://localhost:3000";
  const magicLink = `${frontendUrl}/manage/#/magic-login?token=${encodeURIComponent(token)}&redirectUrl=${encodeURIComponent(redirectUrl || "")}`;

  return magicLink;
};

/**
 * Send Magic Link to the users Email address
 */
export const sendMagicLink = async (
  email: string,
  redirectUrl?: string
): Promise<void> => {
  const magicLink = await createMagicLoginLink(email, redirectUrl);

  const { html, subject } =
    await _GLOBAL_SERVER_CONFIG.emailTemplates.magicLink({
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
 * Send Verification Email to the users Email address
 */
export const sendVerificationEmail = async (email: string) => {
  // Create a token
  const token = await createMagicLinkToken(email, "email_verification");

  // Construct the magic link URL
  const frontendUrl = _GLOBAL_SERVER_CONFIG.baseUrl || "http://localhost:3000";
  const magicLink = `${frontendUrl}/manage/#/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

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
  // Find the magic link record
  const nowMinusExpireTime = new Date(Date.now() - EXPIRE_TIME).toISOString();
  const magicLinkResult = await getDb()
    .select()
    .from(magicLinkSessions)
    .where(
      and(
        eq(magicLinkSessions.token, token),
        gt(magicLinkSessions.expiresAt, nowMinusExpireTime)
      )
    );

  if (magicLinkResult.length === 0) {
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
  if (user.length === 0) {
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
 * Verify Magic Link Token and Authenticate User
 */
export const verifyMagicLink = async (
  token: string
): Promise<{ user: UserSelectBasic; token: string }> => {
  // Verify the email token
  const { user, tokenId } = await verifyEmailToken(token);

  // Generate a session token (JWT)
  const { token: sessionToken } = await generateJwt(
    user,
    _GLOBAL_SERVER_CONFIG.jwtExpiresAfter
  );
  await deleteMagicLinkToken(tokenId);

  return { user, token: sessionToken };
};

/**
 * Verify Magic Link Token and Authenticate User
 */
export const verifyEmail = async (
  token: string
): Promise<{ user: UserSelectBasic; token: string }> => {
  // Verify the email token
  const { user, tokenId } = await verifyEmailToken(token);

  // Update the user's emailVerified status
  await getDb()
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, user.id));

  // Generate a session token (JWT)
  const { token: sessionToken } = await generateJwt(
    user,
    _GLOBAL_SERVER_CONFIG.jwtExpiresAfter
  );
  await deleteMagicLinkToken(tokenId);

  return { user, token: sessionToken };
};

/**
 * Creates a reset password link for the user
 */
export const createResetPasswordLink = async (
  email: string
): Promise<string> => {
  const token = await createMagicLinkToken(email, "password_reset");
  const frontendUrl = _GLOBAL_SERVER_CONFIG.baseUrl || "http://localhost:3000";
  // Example path /manage/#/reset-password?token=...
  const resetLink = `${frontendUrl}/manage/#/reset-password?token=${encodeURIComponent(token)}`;
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
  const nowMinusExpireTime = new Date(Date.now() - EXPIRE_TIME).toISOString();
  const magicLinkResult = await getDb()
    .select()
    .from(magicLinkSessions)
    .where(
      and(
        eq(magicLinkSessions.token, token),
        eq(magicLinkSessions.purpose, "password_reset"),
        gt(magicLinkSessions.expiresAt, nowMinusExpireTime)
      )
    );

  if (magicLinkResult.length === 0) {
    throw new Error("Invalid or expired password reset token");
  }

  // Token is valid - delete it immediately, so it cannot be reused
  await deleteMagicLinkToken(magicLinkResult[0].id);

  return { userId: magicLinkResult[0].userId };
};
