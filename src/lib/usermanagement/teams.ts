/**
 * CRUD operations for teams
 *
 * Teams are used to group users together inside a tenant
 */

import { getDb } from "../db/db-connection";
import { eq, and, ne } from "drizzle-orm";
import {
  teams,
  teamMembers,
  type TeamsSelect,
  type TeamsInsert,
  users,
  type TeamMembersSelect,
} from "../db/schema/users";
import { getUserTenants } from "./tenants";

/**
 * Create a team
 */
export const createTeam = async (data: TeamsInsert): Promise<TeamsSelect> => {
  const result = await getDb().insert(teams).values(data).returning();
  if (!result[0]) {
    throw new Error("Failed to create team");
  }
  return result[0];
};

/**
 * Get a team by its ID
 */
export const getTeam = async (teamId: string): Promise<TeamsSelect | null> => {
  const team = await getDb().select().from(teams).where(eq(teams.id, teamId));
  return team[0] ?? null;
};

/**
 * Update a team
 */
export const updateTeam = async (
  teamId: string,
  data: Partial<TeamsSelect>
): Promise<TeamsSelect> => {
  const result = await getDb()
    .update(teams)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(teams.id, teamId))
    .returning();
  if (!result[0]) {
    throw new Error("Failed to update team");
  }
  return result[0];
};

/**
 * Delete a team
 */
export const deleteTeam = async (teamId: string): Promise<void> => {
  await getDb().delete(teams).where(eq(teams.id, teamId));
};

/**
 * Get all teams by an tenant ID
 */
export const getTeamsByOrganisation = async (
  orgId: string
): Promise<TeamsSelect[]> => {
  return await getDb().select().from(teams).where(eq(teams.tenantId, orgId));
};

/**
 * Get all team for a specific user
 */
export const getTeamsByUser = async (
  userId: string,
  orgId: string
): Promise<{ teamId: string; name: string; role: string }[]> => {
  return await getDb()
    .select({
      teamId: teams.id,
      name: teams.name,
      role: teamMembers.role,
    })
    .from(teams)
    .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
    .where(and(eq(teamMembers.userId, userId), eq(teams.tenantId, orgId)));
};

/**
 * Get all members of a team
 */
export const getTeamMembers = async (
  userId: string,
  orgId: string,
  teamId: string
): Promise<
  { teamId: string; userId: string; userEmail: string; role: string }[]
> => {
  return await getDb()
    .select({
      teamId: teamMembers.teamId,
      userId: teamMembers.userId,
      userEmail: users.email,
      role: teamMembers.role,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId));
};

/**
 * Drop the membership of a user from a team
 */
export const dropUserFromTeam = async (
  userId: string,
  teamId: string
): Promise<void> => {
  // check if the team has at least one admin
  const admins = await getDb()
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.role, "admin"),
        ne(teamMembers.userId, userId)
      )
    );
  if (admins.length === 0) {
    throw new Error(
      "Team must have at least one admin before dropping this user"
    );
  }

  await getDb()
    .delete(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)));
};

/**
 * Add a team member to a team
 */
export const addTeamMember = async (
  teamId: string,
  tenantId: string,
  userId: string,
  role?: "admin" | "member"
): Promise<TeamMembersSelect> => {
  // check if the user is part of the tenant
  const tenants = await getUserTenants(userId);
  const membership = tenants.find((tenant) => tenant.tenantId === tenantId);
  if (!membership) {
    throw new Error("User is not part of the tenant");
  }

  const result = await getDb()
    .insert(teamMembers)
    .values({
      teamId,
      userId,
      role,
    })
    .returning();
  if (!result[0]) {
    throw new Error("Failed to add team member");
  }
  return result[0];
};

export const checkTeamMemberRole = async (
  teamId: string,
  userId: string,
  roleToCheck: ("admin" | "member")[]
): Promise<boolean> => {
  // check membership
  const member = await getDb()
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));

  if (!member[0]) {
    throw new Error("User has not the required role");
  }
  if (roleToCheck.includes(member[0].role)) {
    return true;
  } else {
    throw new Error("User has not the required role");
  }
};

/**
 * Remove a team member from a team
 */
export const removeTeamMember = async (
  teamId: string,
  destinationUserId: string
): Promise<void> => {
  // check if the team is not empty after dropping
  const members = await getDb()
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  if (members.length === 1) {
    throw new Error("Team must have at least one member");
  }

  // check if the team has at least one more admin
  const admins = await getDb()
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.role, "admin"),
        ne(teamMembers.userId, destinationUserId)
      )
    );
  if (admins.length === 0) {
    throw new Error("Team must have at least one admin");
  }

  // do the actual removal
  await getDb()
    .delete(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, destinationUserId)
      )
    );
};

/**
 * Update the role of a team member
 */
export const updateTeamMemberRole = async (
  teamId: string,
  destinationUserId: string,
  role: "admin" | "member"
): Promise<TeamMembersSelect> => {
  // do the actual update
  const result = await getDb()
    .update(teamMembers)
    .set({ role })
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, destinationUserId)
      )
    )
    .returning();
  if (!result[0]) {
    throw new Error("Failed to update team member role");
  }
  return result[0];
};

/**
 * Check if a user is part of a team
 */
export const isUserPartOfTeam = async (
  userId: string,
  teamId: string
): Promise<boolean> => {
  const result = await getDb()
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)));
  return result.length > 0;
};
