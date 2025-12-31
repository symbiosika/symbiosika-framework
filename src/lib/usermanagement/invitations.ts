/**
 * This file contains the functions for managing tenant invitations
 * Invitations are used to invite users to an tenant
 */

import { eq, and } from "drizzle-orm";
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
export const dropTenantInvitation = async (invitationId: string) => {
  await getDb()
    .delete(tenantInvitations)
    .where(eq(tenantInvitations.id, invitationId));
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

    await trx.insert(tenantMembers).values({
      userId,
      tenantId: invitation.tenantId,
      role: invitation.role,
    });

    await trx
      .update(users)
      .set({
        emailVerified: true,
        lastTenantId: invitation.tenantId,
      })
      .where(eq(users.id, userId));
  });

  await setUsersLastTenant(userId, invitation.tenantId);
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

      await trx.insert(tenantMembers).values({
        userId,
        tenantId: invitation.tenantId,
        role: "member",
      });
    }
  });

  await setUsersLastTenant(userId, tenantId);
};

/**
 * Decline an invitation by its ID
 */
export const declineTenantInvitation = async (invitationId: string) => {
  await getDb()
    .update(tenantInvitations)
    .set({ status: "declined" })
    .where(eq(tenantInvitations.id, invitationId));
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

  // send mail
  if (sendMail) {
    // check if user exists
    const user = await getUserByEmail(dataWithStatus.email).catch(() => {});

    // when the user is existing send only invite to tenant
    if (user) {
      const { html, subject } =
        await _GLOBAL_SERVER_CONFIG.emailTemplates.inviteToOrganizationWhenUserExists(
          {
            appName: _GLOBAL_SERVER_CONFIG.appName,
            baseUrl: _GLOBAL_SERVER_CONFIG.baseUrl,
            logoUrl: _GLOBAL_SERVER_CONFIG.logoUrl,
            link: `${_GLOBAL_SERVER_CONFIG.baseUrl || "http://localhost:3000"}/static/app/#/shared/tenants`,
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
          link: `${_GLOBAL_SERVER_CONFIG.baseUrl}${_GLOBAL_SERVER_CONFIG.loginUrl}?register=true&email=${encodeURIComponent(dataWithStatus.email)}&hideInvitationCode=true`,
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
