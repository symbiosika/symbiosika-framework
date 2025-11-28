/**
 * CRUD operations for tenants and teams
 */

import { getDb } from "../db/db-connection";
import { eq, and, sql, ne, or, inArray } from "drizzle-orm";
import {
  tenants,
  teams,
  teamMembers,
  userPermissionGroups,
  pathPermissions,
  groupPermissions,
  type TenantsSelect,
  type TenantsInsert,
  users,
  tenantMembers,
} from "../db/schema/users";
import { setUsersLastTenant } from "./user";

/**
 * Create an tenant
 */
export const createTenant = async (data: TenantsInsert) => {
  const result = await getDb().insert(tenants).values(data).returning();
  if (!result[0]) {
    throw new Error("Failed to create tenant");
  }
  return result[0];
};

/**
 * Get an tenant by its ID
 */
export const getTenant = async (tenantId: string) => {
  const tenant = await getDb()
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return tenant[0];
};

/**
 * Update an tenant
 */
export const updateTenant = async (
  orgId: string,
  data: Partial<TenantsSelect>
) => {
  const result = await getDb()
    .update(tenants)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(tenants.id, orgId))
    .returning();
  return result[0];
};

/**
 * Delete an tenant
 */
export const deleteTenant = async (orgId: string) => {
  await getDb().delete(tenants).where(eq(tenants.id, orgId));
};

/**
 * Get all tenants of a user
 */
export const getUserTenants = async (userId: string) => {
  return await getDb()
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      role: tenantMembers.role,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(eq(tenantMembers.userId, userId));
};

/**
 * Drop the membership of a user from an tenant
 */
export const dropUserFromTenant = async (userId: string, tenantId: string) => {
  // check if the tenant has at least one owner that is NOT the user
  const owners = await getDb()
    .select()
    .from(tenantMembers)
    .where(
      and(
        eq(tenantMembers.tenantId, tenantId),
        or(eq(tenantMembers.role, "owner"), eq(tenantMembers.role, "admin")),
        ne(tenantMembers.userId, userId)
      )
    );
  if (owners.length < 1) {
    throw new Error("Tenant must have at least one owner or admin");
  }

  // drop the membership of the user from the tenant
  await getDb()
    .delete(tenantMembers)
    .where(
      and(
        eq(tenantMembers.userId, userId),
        eq(tenantMembers.tenantId, tenantId)
      )
    );

  // drop the membership of the user from all teams
  await getDb()
    .delete(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        inArray(
          teamMembers.teamId,
          getDb()
            .select({
              teamId: teams.id,
            })
            .from(teams)
            .where(eq(teams.tenantId, tenantId))
        )
      )
    );

  // set the last tenant of the user
  await setUsersLastTenant(userId, tenantId);
};

/**
 * Get the last tenant of a user
 */
export const getLastTenant = async (
  userId: string
): Promise<{
  userId: string;
  lastTenantId: undefined | string;
  tenantName: undefined | string;
}> => {
  const user = await getDb()
    .select({
      userId: users.id,
      lastTenantId: users.lastTenantId,
      tenantName: tenants.name,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user[0]?.lastTenantId)
    return {
      userId,
      lastTenantId: undefined,
      tenantName: undefined,
    };

  const tenant = await getDb()
    .select({
      lastTenantId: tenants.id,
      tenantName: tenants.name,
    })
    .from(tenants)
    .where(eq(tenants.id, user[0].lastTenantId));
  if (!tenant[0])
    return {
      userId,
      lastTenantId: undefined,
      tenantName: undefined,
    };

  return { ...tenant[0], userId };
};

/**
 * Set the last tenant of a user
 */
export const setLastTenant = async (userId: string, tenantId: string) => {
  // Check if user is a member of the tenant
  const membership = await getDb()
    .select()
    .from(tenantMembers)
    .where(
      and(
        eq(tenantMembers.userId, userId),
        eq(tenantMembers.tenantId, tenantId)
      )
    );

  if (!membership.length) {
    throw new Error("User is not a member of this tenant");
  }

  const [result] = await getDb()
    .update(users)
    .set({ lastTenantId: tenantId })
    .where(eq(users.id, userId))
    .returning({
      userId: users.id,
      lastTenantId: users.lastTenantId,
    });
  return result;
};

export const getTeamsAndMembersByTenant = async (tenantId: string) => {
  return await getDb()
    .select({
      team: teams,
      members: sql<Array<{ userId: string; role: string | null }>>`
        json_agg(
          json_build_object(
            'userId', ${teamMembers.userId},
            'role', ${teamMembers.role}
          )
        )`,
    })
    .from(teams)
    .leftJoin(teamMembers, eq(teams.id, teamMembers.teamId))
    .where(eq(teams.tenantId, tenantId))
    .groupBy(teams.id);
};

export const getPermissionsByTenant = async (tenantId: string) => {
  return await getDb()
    .select({
      group: userPermissionGroups,
      permissions: sql<Array<{ id: string; name: string }>>`
        json_agg(
          json_build_object(
            'id', ${pathPermissions.id},
            'name', ${pathPermissions.name}
          )
        )`,
    })
    .from(userPermissionGroups)
    .leftJoin(
      groupPermissions,
      eq(userPermissionGroups.id, groupPermissions.groupId)
    )
    .leftJoin(
      pathPermissions,
      eq(groupPermissions.permissionId, pathPermissions.id)
    )
    .where(eq(userPermissionGroups.tenantId, tenantId))
    .groupBy(userPermissionGroups.id);
};

/**
 * Add a user to an tenant
 */
export const addTenantMember = async (
  tenantId: string,
  userId: string,
  role?: "owner" | "admin" | "member"
) => {
  const result = await getDb()
    .insert(tenantMembers)
    .values({
      tenantId,
      userId,
      role,
    })
    .returning()
    .onConflictDoUpdate({
      target: [tenantMembers.tenantId, tenantMembers.userId],
      set: {
        role,
      },
    });
  return result[0];
};

/**
 * Change the role of a user in an tenant
 */
export const updateTenantMemberRole = async (
  tenantId: string,
  userId: string,
  role: "owner" | "admin" | "member"
) => {
  const result = await getDb()
    .update(tenantMembers)
    .set({ role })
    .where(
      and(
        eq(tenantMembers.tenantId, tenantId),
        eq(tenantMembers.userId, userId)
      )
    )
    .returning();
  return result[0];
};

/**
 * Remove a user from an tenant
 */
export const removeTenantMember = async (tenantId: string, userId: string) => {
  await getDb()
    .delete(tenantMembers)
    .where(
      and(
        eq(tenantMembers.tenantId, tenantId),
        eq(tenantMembers.userId, userId)
      )
    );
};

/**
 * Get all members of an tenant
 */
export const getTenantMembers = async (userId: string, tenantId: string) => {
  return await getDb()
    .select({
      id: tenantMembers.userId,
      userEmail: users.email,
      role: tenantMembers.role,
      joinedAt: tenantMembers.joinedAt,
    })
    .from(tenantMembers)
    .leftJoin(users, eq(tenantMembers.userId, users.id))
    .where(eq(tenantMembers.tenantId, tenantId));
};

/**
 * Get the role of a userId in an tenant
 */
export const getTenantMemberRole = async (
  tenantId: string,
  userId: string
): Promise<"owner" | "admin" | "member"> => {
  const result = await getDb()
    .select({
      role: tenantMembers.role,
    })
    .from(tenantMembers)
    .where(
      and(
        eq(tenantMembers.tenantId, tenantId),
        eq(tenantMembers.userId, userId)
      )
    );
  if (!result[0]) {
    throw new Error("User is not a member of this tenant");
  }
  return result[0].role;
};

/**
 * Check a role of a user in an tenant
 * Throw an error if the user does not have the role
 */
export const checkTenantMemberRole = async (
  tenantId: string,
  userId: string,
  role: ("owner" | "admin" | "member")[]
) => {
  const result = await getDb()
    .select({
      role: tenantMembers.role,
    })
    .from(tenantMembers)
    .where(
      and(
        eq(tenantMembers.tenantId, tenantId),
        eq(tenantMembers.userId, userId)
      )
    );
  if (!result[0]) {
    throw new Error("User is not a member of this tenant");
  }
  if (!role.includes(result[0].role)) {
    throw new Error("User has not the required role");
  }
};
