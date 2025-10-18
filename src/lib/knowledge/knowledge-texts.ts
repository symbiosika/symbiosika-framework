import { and, asc, eq, or, isNull, type SQLWrapper, exists } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  knowledgeText,
  type KnowledgeTextInsert,
} from "../db/schema/knowledge";
import { RESPONSES } from "../responses";
import { teamMembers } from "../db/schema/users";
import { checkOrganisationMemberRole } from "../usermanagement/oganisations";
import { checkTeamMemberRole } from "../usermanagement/teams";

/**
 * Create a new knowledgeText entry
 */
export const createKnowledgeText = async (data: KnowledgeTextInsert) => {
  // check permission
  if (data.userId && data.teamId) {
    await checkTeamMemberRole(data.teamId, data.userId, ["admin"]);
  } else if (data.userId && data.organisationWide) {
    await checkOrganisationMemberRole(data.organisationId, data.userId, [
      "admin",
      "owner",
    ]);
  }

  const e = await getDb().insert(knowledgeText).values(data).returning();
  return e[0];
};

/**
 * Read all knowledgeText entries or a specific entry by ID
 */
export const getKnowledgeText = async (filters: {
  id?: string;
  organisationId: string;
  teamId?: string;
  userId?: string;
  workspaceId?: string;
  limit?: number;
  page?: number;
}) => {
  const permissionConditions: SQLWrapper[] = [
    eq(knowledgeText.organisationId, filters.organisationId),
  ];

  if (filters.userId) {
    permissionConditions.push(
      or(
        // User specific entries
        eq(knowledgeText.userId, filters.userId),
        // Team specific entries (only if user is a member of the team)
        and(
          isNull(knowledgeText.teamId),
          eq(knowledgeText.organisationWide, true)
        ),
        exists(
          getDb()
            .select()
            .from(teamMembers)
            .where(
              and(
                eq(teamMembers.userId, filters.userId),
                eq(teamMembers.teamId, knowledgeText.teamId)
              )
            )
        )
      )!
    );
  }

  if (filters.teamId) {
    permissionConditions.push(eq(knowledgeText.teamId, filters.teamId));
  }

  if (filters.id) {
    permissionConditions.push(eq(knowledgeText.id, filters.id));
  }

  const query = getDb()
    .select()
    .from(knowledgeText)
    .orderBy(asc(knowledgeText.createdAt))
    .where(and(...permissionConditions))
    .$dynamic();

  if (filters.limit) {
    query.limit(filters.limit);
  }
  if (filters.page && filters.limit) {
    query.offset((filters.page - 1) * filters.limit);
  }
  return await query;
};

/**
 * Get a knowledgeText entry by name, category and organisationId
 */
export const getKnowledgeTextByTitle = async (filters: {
  title: string;
  organisationId: string;
}) => {
  const result = await getDb()
    .select()
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.title, filters.title),
        eq(knowledgeText.organisationId, filters.organisationId)
      )
    );
  if (result.length === 0) {
    throw new Error("Knowledge text not found");
  }
  return result[0];
};

/**
 * Update a knowledgeText entry by ID
 */
export const updateKnowledgeText = async (
  id: string,
  data: Partial<KnowledgeTextInsert>,
  context: {
    organisationId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
  }
) => {
  // First check if user has permission to update this entry
  const existing = await getKnowledgeText({
    id,
    organisationId: context.organisationId,
    userId: context.userId,
    teamId: context.teamId,
    workspaceId: context.workspaceId,
  });

  // check permission
  if (context.userId && existing.length === 0) {
    throw new Error("Knowledge text not found or access denied");
  } else if (context.userId) {
    const item = existing[0];
    if (item.organisationWide) {
      await checkOrganisationMemberRole(
        context.organisationId,
        context.userId,
        ["admin", "owner"]
      );
    } else if (item.teamId) {
      await checkTeamMemberRole(item.teamId, context.userId, ["admin"]);
    }
  }

  // update
  const e = await getDb()
    .update(knowledgeText)
    .set({ ...data })
    .where(eq(knowledgeText.id, id))
    .returning();

  return e[0];
};

/**
 * Delete a knowledgeText entry by ID
 */
export const deleteKnowledgeText = async (
  id: string,
  context: {
    organisationId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
  }
) => {
  const e = await getKnowledgeText({
    id,
    organisationId: context.organisationId,
    userId: context.userId,
    teamId: context.teamId,
    workspaceId: context.workspaceId,
  });

  if (context.userId && e.length === 0) {
    throw new Error("Knowledge text not found or access denied");
  } else if (context.userId) {
    const item = e[0];
    if (item.organisationWide) {
      await checkOrganisationMemberRole(
        context.organisationId,
        context.userId,
        ["admin", "owner"]
      );
    } else if (item.teamId) {
      await checkTeamMemberRole(item.teamId, context.userId, ["admin"]);
    }
  }

  await getDb().delete(knowledgeText).where(eq(knowledgeText.id, id));

  return RESPONSES.SUCCESS;
};
