/**
 * Notifications service
 * Business logic for managing user notifications/messages
 */

import { getDb } from "../db/db-connection";
import { userMessages } from "../db/schema/users";
import { eq, and, isNull, desc, inArray } from "drizzle-orm";
import type {
  UserMessagesInsert,
  UserMessagesSelect,
  TenantMemberRole,
} from "../db/schema/users";
import { HTTPException } from "hono/http-exception";
import { tenantMembers, users } from "../db/schema/users";

/**
 * Read all unconfirmed messages for a user
 */
export async function getUserMessages(
  userId: string
): Promise<UserMessagesSelect[]> {
  const db = getDb();

  const messages = await db
    .select()
    .from(userMessages)
    .where(and(eq(userMessages.userId, userId), isNull(userMessages.confirmedAt)))
    .orderBy(desc(userMessages.createdAt));

  return messages;
}

/**
 * Add a message to all users
 */
export async function addMessageToAllUsers(
  message: string,
  messageType: "info" | "warning" | "error" = "info"
): Promise<void> {
  const db = getDb();

  // Get all user IDs
  const allUsers = await db.select({ id: users.id }).from(users);

  if (allUsers.length === 0) {
    return;
  }

  // Insert message for each user
  const messageData: Omit<UserMessagesInsert, "id" | "createdAt">[] =
    allUsers.map((user) => ({
      userId: user.id,
      message,
      messageType,
    }));

  await db.insert(userMessages).values(messageData);
}

/**
 * Add a message to all users with a given tenantId
 */
export async function addMessageToTenantUsers(
  tenantId: string,
  message: string,
  messageType: "info" | "warning" | "error" = "info"
): Promise<void> {
  const db = getDb();

  // Get all user IDs for the tenant
  const tenantUserIds = await db
    .select({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .where(eq(tenantMembers.tenantId, tenantId));

  if (tenantUserIds.length === 0) {
    return;
  }

  // Insert message for each user
  const messageData: Omit<UserMessagesInsert, "id" | "createdAt">[] =
    tenantUserIds.map((member) => ({
      userId: member.userId,
      message,
      messageType,
    }));

  await db.insert(userMessages).values(messageData);
}

/**
 * Add a message to all users of a tenant that hold one of the given tenant
 * roles. Use this to target a notification at e.g. all "admin" and "owner" of
 * a specific tenant instead of every member.
 *
 * No-op if `roles` is empty or no matching member exists.
 */
export async function addMessageToTenantUsersByRoles(
  tenantId: string,
  roles: TenantMemberRole[],
  message: string,
  messageType: "info" | "warning" | "error" = "info"
): Promise<void> {
  if (roles.length === 0) {
    return;
  }

  const db = getDb();

  // Get all user IDs for the tenant that hold one of the given roles
  const tenantUserIds = await db
    .selectDistinct({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .where(
      and(
        eq(tenantMembers.tenantId, tenantId),
        inArray(tenantMembers.role, roles)
      )
    );

  if (tenantUserIds.length === 0) {
    return;
  }

  // Insert message for each user
  const messageData: Omit<UserMessagesInsert, "id" | "createdAt">[] =
    tenantUserIds.map((member) => ({
      userId: member.userId,
      message,
      messageType,
    }));

  await db.insert(userMessages).values(messageData);
}

/**
 * Add a message to all admins/owners across every tenant (system-wide).
 * Useful for operational notices like server restarts. A user that is admin
 * in several tenants only receives the message once.
 *
 * No-op if no admin/owner exists.
 */
export async function addMessageToAllAdmins(
  message: string,
  messageType: "info" | "warning" | "error" = "info"
): Promise<void> {
  const db = getDb();

  const adminUserIds = await db
    .selectDistinct({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .where(inArray(tenantMembers.role, ["owner", "admin"]));

  if (adminUserIds.length === 0) {
    return;
  }

  const messageData: Omit<UserMessagesInsert, "id" | "createdAt">[] =
    adminUserIds.map((member) => ({
      userId: member.userId,
      message,
      messageType,
    }));

  await db.insert(userMessages).values(messageData);
}

/**
 * Mark a message as confirmed for one user
 */
export async function confirmMessage(
  messageId: string,
  userId: string
): Promise<UserMessagesSelect> {
  const db = getDb();

  // Check if message exists and belongs to user
  const [existingMessage] = await db
    .select()
    .from(userMessages)
    .where(and(eq(userMessages.id, messageId), eq(userMessages.userId, userId)))
    .limit(1);

  if (!existingMessage) {
    throw new HTTPException(404, {
      message: "Message not found",
    });
  }

  // Update confirmedAt
  const [updatedMessage] = await db
    .update(userMessages)
    .set({
      confirmedAt: new Date().toISOString(),
    })
    .where(and(eq(userMessages.id, messageId), eq(userMessages.userId, userId)))
    .returning();

  if (!updatedMessage) {
    throw new HTTPException(500, {
      message: "Failed to confirm message",
    });
  }

  return updatedMessage;
}

/**
 * Mark all messages as confirmed for one user
 */
export async function confirmAllMessages(userId: string): Promise<void> {
  const db = getDb();

  await db
    .update(userMessages)
    .set({
      confirmedAt: new Date().toISOString(),
    })
    .where(and(eq(userMessages.userId, userId), isNull(userMessages.confirmedAt)));
}


