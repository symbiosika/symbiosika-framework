import { inArray } from "drizzle-orm";
import { getDb } from "../lib/db/db-connection";
import { teamMembers, teams } from "../lib/db/schema/users";
import { createTeam } from "../lib/usermanagement/teams";
import { nanoid } from "nanoid";
import { type KnowledgeEntrySelect } from "../lib/db/db-schema";
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
 * Helper function to create a knowledge entry
 * FOR TESTING PURPOSES ONLY. WILL NOT CHECK FOR PERMISSIONS.
 */
export const testing_createKnowledgeEntry = async (data: {
  tenantId: string;
  userId: string;
  workspaceId?: string;
  teamId?: string;
  userOwned?: boolean;
}): Promise<KnowledgeEntrySelect> => {
  const knowledgeEntry = await storeKnowledgeEntry({
    ...data,
    name: nanoid(8),
  });

  return knowledgeEntry;
};
