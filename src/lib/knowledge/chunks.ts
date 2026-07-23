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
import { knowledgeChunks, knowledgeEntry } from "../db/schema/knowledge";
import { getUserTeamIds } from "./permissions";

/**
 * Get a knowledge chunk by ID with user context validation
 */
export const getKnowledgeChunkById = async (
  id: string,
  tenantId: string,
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
            eq(knowledgeEntry.tenantId, tenantId)
          )
        )
    ),
  ];

  const userTeams = await getUserTeamIds(userId, tenantId);

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
