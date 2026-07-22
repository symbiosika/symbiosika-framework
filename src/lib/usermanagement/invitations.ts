/**
 * This file contains the functions for managing tenant invitations
 * Invitations are used to invite users to an tenant
 */

import { eq, and } from "drizzle-orm";
import jwt from "jsonwebtoken";
import {
  invitationCodes,
  tenantInvitations,
  type TenantInvitationsInsert,
  tenantMembers,
  tenants,
  users,
} from "../db/schema/users";
import { getDb } from "../db/db-connection";
import { getUserByEmail, getUserById, setUsersLastTenant } from "./user";
import { addUserToDefaultTeams } from "./teams";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { smtpService } from "../email";
import log from "../log";

/**
 * Get all tenant invitations
 */
export const getAllTenantInvitations = async (tenantId: string) => {
  return await getDb()
    .select()
    .from(tenantInvitations)
    .where(eq(tenantInvitations.tenantId, tenantId));
};

/**
 * Get all tenant invitations
 */
export const getUsersTenantInvitations = async (userId: string) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error("User not found");
  }
  return await getDb()
    .select({
      id: tenantInvitations.id,
      tenantId: tenantInvitations.tenantId,
      tenantName: tenants.name,
      email: tenantInvitations.email,
      status: tenantInvitations.status,
      role: tenantInvitations.role,
    })
    .from(tenantInvitations)
    .leftJoin(tenants, eq(tenantInvitations.tenantId, tenants.id))
    .where(
      and(
        eq(tenantInvitations.email, user.email),
        eq(tenantInvitations.status, "pending")
      )
    );
};

/**
 * Drop an invitation by its ID
 */
export const dropTenantInvitation = async (
  invitationId: string,
  tenantId: string
) => {
  // Scope to the tenant so an admin of one tenant cannot delete another
  // tenant's invitations by guessing ids.
  await getDb()
    .delete(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.id, invitationId),
        eq(tenantInvitations.tenantId, tenantId)
      )
    );
};

/**
 * Accept an invitation with its ID and for one user
 */
export const acceptTenantInvitation = async (
  invitationId: string,
  userId: string,
  tenantId: string
) => {
  const invitations = await getDb()
    .select()
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.id, invitationId),
        eq(tenantInvitations.tenantId, tenantId)
      )
    );
  const invitation = invitations[0] || undefined;

  if (!invitation || invitation.status !== "pending") {
    throw new Error("Invitation not found or not pending");
  }

  const userRes = await getDb()
    .select({
      id: users.id,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId));
  const user = userRes[0] || undefined;

  if (!user || user.email !== invitation.email) {
    throw new Error("User email does not match invitation email");
  }

  await getDb().transaction(async (trx) => {
    await trx
      .update(tenantInvitations)
      .set({ status: "accepted" })
      .where(eq(tenantInvitations.id, invitationId));

    // Stay idempotent: re-accepting an invitation for a tenant the user is
    // already a member of must not fail on the primary-key conflict.
    await trx
      .insert(tenantMembers)
      .values({
        userId,
        tenantId: invitation.tenantId,
        role: invitation.role,
      })
      .onConflictDoNothing();

    await trx
      .update(users)
      .set({
        emailVerified: true,
        lastTenantId: invitation.tenantId,
      })
      .where(eq(users.id, userId));
  });

  // Auto-join all teams that are flagged to add new tenant users by default.
  await addUserToDefaultTeams(userId, invitation.tenantId);

  await setUsersLastTenant(userId, invitation.tenantId);
};

/**
 * Secure, self-contained token that encodes a single tenant invitation.
 *
 * The token is a short-lived JWT signed with the server's JWT key (the same
 * symmetric key used for login sessions). It carries only the invitation id
 * plus a dedicated `purpose` claim, so it can never be mistaken for a login /
 * session token. Because the invitation email is delivered to the invitee's
 * mailbox, possession of the token proves control of that address – the same
 * trust model as a magic login link.
 */
const INVITATION_TOKEN_PURPOSE = "tenant_invitation";
// 7 days – matches the "valid for 7 days" copy in the invitation emails.
const INVITATION_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

const getInvitationTokenKey = () => process.env.JWT_PRIVATE_KEY || "";

/**
 * Create a signed acceptance token for an invitation id.
 */
export const createInvitationToken = (invitationId: string): string => {
  return jwt.sign(
    { invitationId, purpose: INVITATION_TOKEN_PURPOSE },
    getInvitationTokenKey(),
    { expiresIn: INVITATION_TOKEN_TTL_SECONDS }
  );
};

/**
 * Verify an acceptance token and extract its invitation id. Throws when the
 * token is invalid, expired, or not an invitation token.
 */
export const verifyInvitationToken = (
  token: string
): { invitationId: string } => {
  const decoded = jwt.verify(token, getInvitationTokenKey()) as
    | { invitationId?: string; purpose?: string }
    | string;
  if (
    !decoded ||
    typeof decoded === "string" ||
    decoded.purpose !== INVITATION_TOKEN_PURPOSE ||
    !decoded.invitationId
  ) {
    throw new Error("Invalid invitation token");
  }
  return { invitationId: decoded.invitationId };
};

export type AcceptInvitationByTokenResult =
  | {
      status: "accepted";
      userId: string;
      tenantId: string;
      email: string;
    }
  | {
      status: "needs_registration";
      tenantId: string;
      email: string;
    };

/**
 * Accept a tenant invitation directly from the token embedded in the
 * invitation email – the "one click = accepted" flow.
 *
 * - Existing users: the invitation is accepted immediately and the caller is
 *   handed the userId so it can establish a login session.
 * - Not-yet-registered emails: a membership cannot exist before an account
 *   does, so the caller is told to route the user through registration. The
 *   registration flow (`LocalAuth.register`) auto-accepts every pending
 *   invitation for the email, so membership is confirmed the moment the
 *   account is created.
 *
 * The function is idempotent: clicking the link a second time (or a mail
 * scanner pre-opening it) does not error once the invitation is accepted.
 */
export const acceptInvitationByToken = async (
  token: string
): Promise<AcceptInvitationByTokenResult> => {
  const { invitationId } = verifyInvitationToken(token);

  const [invitation] = await getDb()
    .select()
    .from(tenantInvitations)
    .where(eq(tenantInvitations.id, invitationId));

  if (!invitation) {
    throw new Error("Invitation not found");
  }

  // Look up the invited user by the invitation email.
  const [user] = await getDb()
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, invitation.email));

  // No account yet -> the user must register first. Registration will pick up
  // and accept this (still pending) invitation automatically.
  if (!user) {
    return {
      status: "needs_registration",
      tenantId: invitation.tenantId,
      email: invitation.email,
    };
  }

  if (invitation.status === "pending") {
    // Normal case: accept the still-pending invitation.
    await acceptTenantInvitation(invitation.id, user.id, invitation.tenantId);
  } else {
    // Already accepted (or previously declined) -> keep the result idempotent
    // by ensuring the membership exists and the invitation is marked accepted.
    await getDb().transaction(async (trx) => {
      await trx
        .update(tenantInvitations)
        .set({ status: "accepted" })
        .where(eq(tenantInvitations.id, invitation.id));

      await trx
        .insert(tenantMembers)
        .values({
          userId: user.id,
          tenantId: invitation.tenantId,
          role: invitation.role,
        })
        .onConflictDoNothing();

      await trx
        .update(users)
        .set({ emailVerified: true, lastTenantId: invitation.tenantId })
        .where(eq(users.id, user.id));
    });
    // Auto-join all teams that are flagged to add new tenant users by default.
    await addUserToDefaultTeams(user.id, invitation.tenantId);
    await setUsersLastTenant(user.id, invitation.tenantId);
  }

  return {
    status: "accepted",
    userId: user.id,
    tenantId: invitation.tenantId,
    email: invitation.email,
  };
};

/**
 * Accept all pending invitations for a user independent of a specific invitation
 */
export const acceptAllPendingInvitationsForTenantMember = async (
  userId: string,
  tenantId: string
) => {
  const userRes = await getDb()
    .select({
      id: users.id,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId));
  const user = userRes[0] || undefined;

  if (!user) {
    throw new Error("User not found");
  }

  const pendingInvitations = await getDb()
    .select()
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.email, user.email),
        eq(tenantInvitations.status, "pending"),
        eq(tenantInvitations.tenantId, tenantId)
      )
    );

  if (pendingInvitations.length === 0) {
    throw new Error("No pending invitations found");
  }

  await getDb().transaction(async (trx) => {
    for (const invitation of pendingInvitations) {
      await trx
        .update(tenantInvitations)
        .set({ status: "accepted" })
        .where(eq(tenantInvitations.id, invitation.id));

      // Honor the role from the invitation (an admin invite must not be
      // silently downgraded to "member") and stay idempotent if the user is
      // already a member of the tenant.
      await trx
        .insert(tenantMembers)
        .values({
          userId,
          tenantId: invitation.tenantId,
          role: invitation.role,
        })
        .onConflictDoNothing();
    }
  });

  // Auto-join all teams that are flagged to add new tenant users by default.
  await addUserToDefaultTeams(userId, tenantId);

  await setUsersLastTenant(userId, tenantId);
};

/**
 * Decline an invitation by its ID
 */
export const declineTenantInvitation = async (
  invitationId: string,
  tenantId: string
) => {
  await getDb()
    .update(tenantInvitations)
    .set({ status: "declined" })
    .where(
      and(
        eq(tenantInvitations.id, invitationId),
        eq(tenantInvitations.tenantId, tenantId)
      )
    );
};

/**
 * Decline all pending invitations for a user independent of a specific invitation
 */
export const declineAllPendingInvitationsForTenantMember = async (
  userId: string,
  tenantId: string
) => {
  const userRes = await getDb()
    .select({
      id: users.id,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId));
  const user = userRes[0] || undefined;

  if (!user) {
    throw new Error("User not found");
  }

  await getDb()
    .update(tenantInvitations)
    .set({ status: "declined" })
    .where(
      and(
        eq(tenantInvitations.email, user.email),
        eq(tenantInvitations.tenantId, tenantId)
      )
    );
};

/**
 * Create a new invitation in the database
 */
export const createTenantInvitation = async (
  data: TenantInvitationsInsert,
  sendMail = false
) => {
  log.info("Creating tenant invitation. Send Mail? " + sendMail);

  // Ensure data has a status field, defaulting to "pending" if not provided
  const dataWithStatus = {
    ...data,
    status: data.status || "pending",
  };

  const [tenantRes] = await getDb()
    .select({
      name: tenants.name,
    })
    .from(tenants)
    .where(eq(tenants.id, dataWithStatus.tenantId))
    .limit(1);

  if (!tenantRes) {
    throw new Error("Tenant not found");
  }

  const [result] = await getDb()
    .insert(tenantInvitations)
    .values(dataWithStatus)
    .onConflictDoUpdate({
      target: [tenantInvitations.tenantId, tenantInvitations.email],
      set: {
        status: dataWithStatus.status,
        // Also update role if it's provided
        ...(dataWithStatus.role ? { role: dataWithStatus.role } : {}),
      },
    })
    .returning();

  if (!result) {
    throw new Error("Failed to create invitation");
  }

  // send mail
  if (sendMail) {
    // check if user exists
    const user = await getUserByEmail(dataWithStatus.email).catch(() => {});

    // Single "one click = accept" link for both new and existing users. It
    // points at the public accept-invitation endpoint, which accepts the
    // membership on click and either logs an existing user straight in or
    // forwards a new user to registration (which then auto-accepts).
    const acceptToken = createInvitationToken(result.id);
    const acceptLink = `${_GLOBAL_SERVER_CONFIG.baseUrl}${_GLOBAL_SERVER_CONFIG.basePath}/user/accept-invitation?token=${encodeURIComponent(acceptToken)}`;

    // when the user is existing send only invite to tenant
    if (user) {
      const { html, subject } =
        await _GLOBAL_SERVER_CONFIG.emailTemplates.inviteToOrganizationWhenUserExists(
          {
            appName: _GLOBAL_SERVER_CONFIG.appName,
            baseUrl: _GLOBAL_SERVER_CONFIG.baseUrl,
            logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
            link: acceptLink,
            user: {
              firstname: user.firstname,
              surname: user.surname,
              email: user.email,
            },
            tenant: {
              id: dataWithStatus.tenantId,
              name: tenantRes.name,
            },
          }
        );
      await smtpService.sendMail({
        sender: process.env.SMTP_FROM,
        recipients: [dataWithStatus.email],
        subject,
        html,
      });
    }
    // when user is not existing send mail to invite user to register
    else {
      const { html, subject } =
        await _GLOBAL_SERVER_CONFIG.emailTemplates.inviteToOrganization({
          appName: _GLOBAL_SERVER_CONFIG.appName,
          baseUrl: _GLOBAL_SERVER_CONFIG.baseUrl,
          logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
          link: acceptLink,
          tenant: {
            id: dataWithStatus.tenantId,
            name: tenantRes.name,
          },
        });
      await smtpService.sendMail({
        sender: process.env.SMTP_FROM,
        recipients: [dataWithStatus.email],
        subject,
        html,
      });
    }
  }

  return result;
};

/**
 * A check function is an inviation code is needed to register
 */
export const checkIfInvitationCodeIsNeededToRegister = async () => {
  const codes = await getDb()
    .select()
    .from(invitationCodes)
    .where(eq(invitationCodes.isActive, true));

  return codes.length > 0;
};

/**
 * Get all pending invitations for a email address
 */
export const getPendingInvitationsForEmail = async (
  email: string
): Promise<{
  invitedInTenantIds: string[];
}> => {
  const invitations = await getDb()
    .select()
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.email, email),
        eq(tenantInvitations.status, "pending")
      )
    );

  return {
    invitedInTenantIds: invitations.map((invitation) => invitation.tenantId),
  };
};
