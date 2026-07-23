import { getDb } from "../db/db-connection";
import { and, eq, inArray, or, isNull } from "drizzle-orm";
import { knowledgeEntry } from "../db/schema/knowledge";
import { teamMembers } from "../db/schema/users";

/**
 * Helper function to get all team IDs a user is a member of
 */
export const getUserTeamIds = async (
  userId: string,
  tenantId: string
): Promise<string[]> => {
  const userTeams = await getDb().query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    columns: {
      teamId: true,
    },
    with: {
      team: true,
    },
  });
  // Filter the teams by tenantId after fetching
  return userTeams
    .filter((t) => t.team.tenantId === tenantId)
    .map((t) => t.teamId);
};

/**
 * Helper to validate if a user can access a knowledge entry
 * will take the knowledge id and the userid
 */
export const validateKnowledgeAccess = async (
  knowledgeId: string,
  userId: string,
  tenantId: string
) => {
  const userTeams = await getUserTeamIds(userId, tenantId);

  // Check: user has direct access to the knowledge entry.
  // The entry MUST belong to the requested tenant — without this filter any
  // entry with a NULL teamId would be accessible across tenant boundaries.
  const directAccess = await getDb().query.knowledgeEntry.findFirst({
    where: and(
      eq(knowledgeEntry.id, knowledgeId),
      eq(knowledgeEntry.tenantId, tenantId),
      or(
        eq(knowledgeEntry.userId, userId),
        // Include NULL teamId and entries with user's teams
        or(
          isNull(knowledgeEntry.teamId),
          inArray(knowledgeEntry.teamId, userTeams)
        )
      )
    ),
  });

  return !!directAccess;
};
