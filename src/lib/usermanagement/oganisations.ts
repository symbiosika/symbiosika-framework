/**
 * CRUD operations for organisations and teams
 */

import { getDb } from "../db/db-connection";
import { eq, and, sql, ne, or, inArray } from "drizzle-orm";
import {
  organisations,
  teams,
  teamMembers,
  userPermissionGroups,
  pathPermissions,
  groupPermissions,
  type OrganisationsSelect,
  type OrganisationsInsert,
  users,
  organisationMembers,
} from "../db/schema/users";
import { setAnotherOrganisationAsLast } from "./user";

/**
 * Create an organisation
 */
export const createOrganisation = async (data: OrganisationsInsert) => {
  const result = await getDb().insert(organisations).values(data).returning();
  return result[0];
};

/**
 * Get an organisation by its ID
 */
export const getOrganisation = async (orgId: string) => {
  const org = await getDb()
    .select()
    .from(organisations)
    .where(eq(organisations.id, orgId));
  return org[0];
};

/**
 * Update an organisation
 */
export const updateOrganisation = async (
  orgId: string,
  data: Partial<OrganisationsSelect>
) => {
  const result = await getDb()
    .update(organisations)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(organisations.id, orgId))
    .returning();
  return result[0];
};

/**
 * Delete an organisation
 */
export const deleteOrganisation = async (orgId: string) => {
  await getDb().delete(organisations).where(eq(organisations.id, orgId));
};

/**
 * Get all organisations of a user
 */
export const getUserOrganisations = async (userId: string) => {
  return await getDb()
    .select({
      organisationId: organisations.id,
      name: organisations.name,
      role: organisationMembers.role,
    })
    .from(organisationMembers)
    .innerJoin(
      organisations,
      eq(organisations.id, organisationMembers.organisationId)
    )
    .where(eq(organisationMembers.userId, userId));
};

/**
 * Drop the membership of a user from an organisation
 */
export const dropUserFromOrganisation = async (
  userId: string,
  organisationId: string
) => {
  // check if the organisation has at least one owner that is NOT the user
  const owners = await getDb()
    .select()
    .from(organisationMembers)
    .where(
      and(
        eq(organisationMembers.organisationId, organisationId),
        or(
          eq(organisationMembers.role, "owner"),
          eq(organisationMembers.role, "admin")
        ),
        ne(organisationMembers.userId, userId)
      )
    );
  if (owners.length < 1) {
    throw new Error("Organisation must have at least one owner or admin");
  }

  // drop the membership of the user from the organisation
  await getDb()
    .delete(organisationMembers)
    .where(
      and(
        eq(organisationMembers.userId, userId),
        eq(organisationMembers.organisationId, organisationId)
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
            .where(eq(teams.organisationId, organisationId))
        )
      )
    );

  // set the last organisation of the user
  await setAnotherOrganisationAsLast(userId, organisationId);
};

/**
 * Get the last organisation of a user
 */
export const getLastOrganisation = async (
  userId: string
): Promise<{
  userId: string;
  lastOrganisationId: undefined | string;
  organisationName: undefined | string;
}> => {
  const user = await getDb()
    .select({
      userId: users.id,
      lastOrganisationId: users.lastOrganisationId,
      organisationName: organisations.name,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user[0]?.lastOrganisationId)
    return {
      userId,
      lastOrganisationId: undefined,
      organisationName: undefined,
    };

  const org = await getDb()
    .select({
      lastOrganisationId: organisations.id,
      organisationName: organisations.name,
    })
    .from(organisations)
    .where(eq(organisations.id, user[0].lastOrganisationId));
  if (!org[0])
    return {
      userId,
      lastOrganisationId: undefined,
      organisationName: undefined,
    };

  return { ...org[0], userId };
};

/**
 * Set the last organisation of a user
 */
export const setLastOrganisation = async (
  userId: string,
  organisationId: string
) => {
  // Check if user is a member of the organisation
  const membership = await getDb()
    .select()
    .from(organisationMembers)
    .where(
      and(
        eq(organisationMembers.userId, userId),
        eq(organisationMembers.organisationId, organisationId)
      )
    );

  if (!membership.length) {
    throw new Error("User is not a member of this organisation");
  }

  const [result] = await getDb()
    .update(users)
    .set({ lastOrganisationId: organisationId })
    .where(eq(users.id, userId))
    .returning({
      userId: users.id,
      lastOrganisationId: users.lastOrganisationId,
    });
  return result;
};

export const getTeamsAndMembersByOrganisation = async (
  organisationId: string
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
    .where(eq(teams.organisationId, organisationId))
    .groupBy(teams.id);
};

export const getPermissionsByOrganisation = async (organisationId: string) => {
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
    .where(eq(userPermissionGroups.organisationId, organisationId))
    .groupBy(userPermissionGroups.id);
};

/**
 * Add a user to an organisation
 */
export const addOrganisationMember = async (
  organisationId: string,
  userId: string,
  role?: "owner" | "admin" | "member"
) => {
  const result = await getDb()
    .insert(organisationMembers)
    .values({
      organisationId,
      userId,
      role,
    })
    .returning()
    .onConflictDoUpdate({
      target: [organisationMembers.organisationId, organisationMembers.userId],
      set: {
        role,
      },
    });
  return result[0];
};

/**
 * Change the role of a user in an organisation
 */
export const updateOrganisationMemberRole = async (
  organisationId: string,
  userId: string,
  role: "owner" | "admin" | "member"
) => {
  const result = await getDb()
    .update(organisationMembers)
    .set({ role })
    .where(
      and(
        eq(organisationMembers.organisationId, organisationId),
        eq(organisationMembers.userId, userId)
      )
    )
    .returning();
  return result[0];
};

/**
 * Remove a user from an organisation
 */
export const removeOrganisationMember = async (
  organisationId: string,
  userId: string
) => {
  await getDb()
    .delete(organisationMembers)
    .where(
      and(
        eq(organisationMembers.organisationId, organisationId),
        eq(organisationMembers.userId, userId)
      )
    );
};

/**
 * Get all members of an organisation
 */
export const getOrganisationMembers = async (
  userId: string,
  organisationId: string
) => {
  return await getDb()
    .select({
      id: organisationMembers.userId,
      userEmail: users.email,
      role: organisationMembers.role,
      joinedAt: organisationMembers.joinedAt,
    })
    .from(organisationMembers)
    .leftJoin(users, eq(organisationMembers.userId, users.id))
    .where(eq(organisationMembers.organisationId, organisationId));
};

/**
 * Get the role of a userId in an organisation
 */
export const getOrganisationMemberRole = async (
  organisationId: string,
  userId: string
): Promise<"owner" | "admin" | "member"> => {
  const result = await getDb()
    .select({
      role: organisationMembers.role,
    })
    .from(organisationMembers)
    .where(
      and(
        eq(organisationMembers.organisationId, organisationId),
        eq(organisationMembers.userId, userId)
      )
    );
  if (result.length < 1) {
    throw new Error("User is not a member of this organisation");
  }
  return result[0].role;
};

/**
 * Check a role of a user in an organisation
 * Throw an error if the user does not have the role
 */
export const checkOrganisationMemberRole = async (
  organisationId: string,
  userId: string,
  role: ("owner" | "admin" | "member")[]
) => {
  const result = await getDb()
    .select({
      role: organisationMembers.role,
    })
    .from(organisationMembers)
    .where(
      and(
        eq(organisationMembers.organisationId, organisationId),
        eq(organisationMembers.userId, userId)
      )
    );
  if (result.length < 1) {
    throw new Error("User is not a member of this organisation");
  }
  if (!role.includes(result[0].role)) {
    throw new Error("User has not the required role");
  }
};
