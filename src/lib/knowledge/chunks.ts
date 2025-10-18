import {
  and,
  eq,
  exists,
  or,
  type SQLWrapper,
  isNull,
  inArray,
} from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  knowledgeChunks,
  knowledgeEntry,
  knowledgeGroup,
  knowledgeGroupTeamAssignments,
} from "../db/schema/knowledge";
import { getUserTeamIds } from "./permissions";

/**
 * Get a knowledge chunk by ID with user context validation
 */
export const getKnowledgeChunkById = async (
  id: string,
  organisationId: string,
  userId: string
) => {
  const filters: SQLWrapper[] = [
    eq(knowledgeChunks.id, id),
    exists(
      getDb()
        .select()
        .from(knowledgeEntry)
        .where(
          and(
            eq(knowledgeEntry.id, knowledgeChunks.knowledgeEntryId),
            eq(knowledgeEntry.organisationId, organisationId)
          )
        )
    ),
  ];

  const userTeams = await getUserTeamIds(userId, organisationId);

  filters.push(
    exists(
      getDb()
        .select()
        .from(knowledgeEntry)
        .where(
          and(
            eq(knowledgeEntry.id, knowledgeChunks.knowledgeEntryId),
            or(
              eq(knowledgeEntry.userId, userId),
              or(
                isNull(knowledgeEntry.teamId),
                inArray(knowledgeEntry.teamId, userTeams)
              ),
              // Knowledge group access - group has org-wide access
              exists(
                getDb()
                  .select()
                  .from(knowledgeGroup)
                  .where(
                    and(
                      eq(knowledgeGroup.id, knowledgeEntry.knowledgeGroupId),
                      eq(knowledgeGroup.organisationWideAccess, true)
                    )
                  )
              ),
              // Knowledge group access - user's team is assigned to the group
              exists(
                getDb()
                  .select()
                  .from(knowledgeGroupTeamAssignments)
                  .where(
                    and(
                      eq(
                        knowledgeGroupTeamAssignments.knowledgeGroupId,
                        knowledgeEntry.knowledgeGroupId
                      ),
                      inArray(knowledgeGroupTeamAssignments.teamId, userTeams)
                    )
                  )
              )
            )
          )
        )
    )
  );

  const result = await getDb()
    .select({
      id: knowledgeChunks.id,
      text: knowledgeChunks.text,
      createdAt: knowledgeChunks.createdAt,
      knowledgeEntryId: knowledgeEntry.id,
      knowledgeEntryName: knowledgeEntry.name,
    })
    .from(knowledgeChunks)
    .leftJoin(
      knowledgeEntry,
      eq(knowledgeChunks.knowledgeEntryId, knowledgeEntry.id)
    )
    .where(and(...filters));

  if (!result[0]) {
    throw new Error("Knowledge chunk not found");
  }

  return result[0];
};
