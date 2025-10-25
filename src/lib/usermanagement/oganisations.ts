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
  type OrganisationsSelect,
  type OrganisationsInsert,
  users,
  tenantMembers,
} from "../db/schema/users";
import { setAnotherOrganisationAsLast } from "./user";

/**
 * Create an tenant
 */
export const createOrganisation = async (data: OrganisationsInsert) => {
  const result = await getDb().insert(tenants).values(data).returning();
  return result[0];
};

/**
 * Get an tenant by its ID
 */
export const getOrganisation = async (orgId: string) => {
  const org = await getDb()
    .select()
    .from(tenants)
    .where(eq(tenants.id, orgId));
  return org[0];
};

/**
 * Update an tenant
 */
export const updateOrganisation = async (
  orgId: string,
  data: Partial<OrganisationsSelect>
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
export const deleteOrganisation = async (orgId: string) => {
  await getDb().delete(tenants).where(eq(tenants.id, orgId));
};

/**
 * Get all tenants of a user
 */
export const getUserOrganisations = async (userId: string) => {
  return await getDb()
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      role: tenantMembers.role,
    })
    .from(tenantMembers)
    .innerJoin(
      tenants,
      eq(tenants.id, tenantMembers.tenantId)
    )
    .where(eq(tenantMembers.userId, userId));
};

/**
 * Drop the membership of a user from an tenant
 */
export const dropUserFromOrganisation = async (
  userId: string,
  tenantId: string
) => {
  // check if the tenant has at least one owner that is NOT the user
  const owners = await getDb()
    .select()
    .from(tenantMembers)
    .where(
      and(
        eq(tenantMembers.tenantId, tenantId),
        or(
          eq(tenantMembers.role, "owner"),
          eq(tenantMembers.role, "admin")
        ),
        ne(tenantMembers.userId, userId)
      )
    );
  if (owners.length < 1) {
    throw new Error("Organisation must have at least one owner or admin");
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
  await setAnotherOrganisationAsLast(userId, tenantId);
};

/**
 * Get the last tenant of a user
 */
export const getLastOrganisation = async (
  userId: string
): Promise<{
  userId: string;
  lastOrganisationId: undefined | string;
  tenantName: undefined | string;
}> => {
  const user = await getDb()
    .select({
      userId: users.id,
      lastOrganisationId: users.lastOrganisationId,
      tenantName: tenants.name,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user[0]?.lastOrganisationId)
    return {
      userId,
      lastOrganisationId: undefined,
      tenantName: undefined,
    };

  const org = await getDb()
    .select({
      lastOrganisationId: tenants.id,
      tenantName: tenants.name,
    })
    .from(tenants)
    .where(eq(tenants.id, user[0].lastOrganisationId));
  if (!org[0])
    return {
      userId,
      lastOrganisationId: undefined,
      tenantName: undefined,
    };

  return { ...org[0], userId };
};

/**
 * Set the last tenant of a user
 */
export const setLastOrganisation = async (
  userId: string,
  tenantId: string
) => {
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
    .set({ lastOrganisationId: tenantId })
    .where(eq(users.id, userId))
    .returning({
      userId: users.id,
      lastOrganisationId: users.lastOrganisationId,
    });
  return result;
};

export const getTeamsAndMembersByOrganisation = async (
  tenantId: string
) => {
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

export const getPermissionsByOrganisation = async (tenantId: string) => {
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
export const addOrganisationMember = async (
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
export const updateOrganisationMemberRole = async (
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
export const removeOrganisationMember = async (
  tenantId: string,
  userId: string
) => {
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
export const getOrganisationMembers = async (
  userId: string,
  tenantId: string
) => {
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
export const getOrganisationMemberRole = async (
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
  if (result.length < 1) {
    throw new Error("User is not a member of this tenant");
  }
  return result[0].role;
};

/**
 * Check a role of a user in an tenant
 * Throw an error if the user does not have the role
 */
export const checkOrganisationMemberRole = async (
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
  if (result.length < 1) {
    throw new Error("User is not a member of this tenant");
  }
  if (!role.includes(result[0].role)) {
    throw new Error("User has not the required role");
  }
};
