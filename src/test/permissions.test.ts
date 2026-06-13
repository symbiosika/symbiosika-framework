import { inArray } from "drizzle-orm";
import { getDb } from "../lib/db/db-connection";
import { teamMembers, teams } from "../lib/db/schema/users";
import { createTeam } from "../lib/usermanagement/teams";
import { nanoid } from "nanoid";
import { createKnowledgeGroup } from "../lib/knowledge/knowledge-groups";
import {
  knowledgeGroup,
  knowledgeGroupTeamAssignments,
  type KnowledgeEntrySelect,
  type KnowledgeGroupSelect,
} from "../lib/db/db-schema";
import { storeKnowledgeEntry } from "../lib/knowledge/add-knowledge";

/**
 * Helper function to create a team
 * and add users to the team
 * FOR TESTING PURPOSES ONLY. WILL NOT CHECK FOR PERMISSIONS.
 */
export const testing_createTeamAndAddUsers = async (
  tenantId: string,
  userIds: string[],
  role: "admin" | "member" = "member"
): Promise<{ teamId: string }> => {
  const team = await createTeam({
    tenantId,
    name: nanoid(8),
  });

  for (const userId of userIds) {
    await getDb().insert(teamMembers).values({
      teamId: team.id,
      userId,
      role,
    });
  }

  return {
    teamId: team.id,
  };
};

/**
 * Helper function to delete a team
 * FOR TESTING PURPOSES ONLY. WILL NOT CHECK FOR PERMISSIONS.
 */
export const testing_deleteTeam = async (teamIds: string[]): Promise<void> => {
  await getDb().delete(teams).where(inArray(teams.id, teamIds));
};

/**
 * Helper function to create a knowledge group
 * FOR TESTING PURPOSES ONLY. WILL NOT CHECK FOR PERMISSIONS.
 */
export const testing_createKnowledgeGroup = async (data: {
  tenantId: string;
  userId: string;
  tenantWideAccess: boolean;
  teamId?: string;
}): Promise<KnowledgeGroupSelect> => {
  const knowledgeGroup = await createKnowledgeGroup({
    ...data,
    name: nanoid(8),
  });

  if (data.teamId) {
    await getDb().insert(knowledgeGroupTeamAssignments).values({
      knowledgeGroupId: knowledgeGroup.id,
      teamId: data.teamId,
    });
  }

  return knowledgeGroup;
};

/**
 * Helper function to delete a knowledge group
 * FOR TESTING PURPOSES ONLY. WILL NOT CHECK FOR PERMISSIONS.
 */
export const testing_deleteKnowledgeGroup = async (
  knowledgeGroupIds: string[]
): Promise<void> => {
  await getDb()
    .delete(knowledgeGroup)
    .where(inArray(knowledgeGroup.id, knowledgeGroupIds));
};

/**
 * Helper function to create a knowledge entry
 * FOR TESTING PURPOSES ONLY. WILL NOT CHECK FOR PERMISSIONS.
 */
export const testing_createKnowledgeEntry = async (data: {
  tenantId: string;
  userId: string;
  workspaceId?: string;
  teamId?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  filters?: Record<string, string>;
}): Promise<KnowledgeEntrySelect> => {
  const knowledgeEntry = await storeKnowledgeEntry(
    {
      ...data,
      name: nanoid(8),
    },
    data.filters ?? {}
  );

  return knowledgeEntry;
};
