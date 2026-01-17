import {
  and,
  asc,
  desc,
  eq,
  or,
  isNull,
  type SQLWrapper,
  exists,
  sql,
  getTableColumns,
} from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  knowledgeText,
  knowledgeTextHistory,
  type KnowledgeTextInsert,
  type KnowledgeTextHistoryInsert,
} from "../db/schema/knowledge";
import { RESPONSES } from "../responses";
import { teamMembers } from "../db/schema/users";
import { checkTenantMemberRole } from "../usermanagement/tenants";
import { checkTeamMemberRole } from "../usermanagement/teams";

/**
 * Create a new knowledgeText entry
 */
export const createKnowledgeText = async (data: KnowledgeTextInsert) => {
  // check permission
  if (data.userId && data.teamId) {
    await checkTeamMemberRole(data.teamId, data.userId, ["admin"]);
  } else if (data.userId && data.tenantWide) {
    await checkTenantMemberRole(data.tenantId, data.userId, ["admin", "owner"]);
  }

  const e = await getDb()
    .insert(knowledgeText)
    .values(data)
    .returning();
  if (!e[0]) {
    throw new Error("Failed to create knowledge text");
  }
  return e[0];
};

/**
 * Get list of all knowledge text entries WITHOUT text content
 * Sorted alphabetically by title
 */
export const getKnowledgeText = async (filters: {
  tenantId: string;
  teamId?: string;
  userId?: string;
  workspaceId?: string;
  limit?: number;
  page?: number;
  includeHidden?: boolean; // Optional: include system/hidden entries
}) => {
  // Exclude 'text' field to reduce payload size
  const permissionConditions: SQLWrapper[] = [
    eq(knowledgeText.tenantId, filters.tenantId),
  ];

  // By default, exclude hidden (system) entries unless explicitly requested
  if (!filters.includeHidden) {
    permissionConditions.push(eq(knowledgeText.hidden, false));
  }

  if (filters.userId) {
    permissionConditions.push(
      or(
        eq(knowledgeText.userId, filters.userId),
        and(isNull(knowledgeText.teamId), eq(knowledgeText.tenantWide, true)),
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

  const { text, ...rest } = getTableColumns(knowledgeText); // exclude "text" column
  const query = getDb()
    .select({ ...rest })
    .from(knowledgeText)
    .where(and(...permissionConditions))
    .orderBy(asc(knowledgeText.title)) // Sort alphabetically by title
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
 * Get a single knowledge text entry by ID with full content
 */
export const getKnowledgeTextById = async (
  id: string,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
    includeHidden?: boolean; // Optional: include system/hidden entries
  }
) => {
  const permissionConditions: SQLWrapper[] = [
    eq(knowledgeText.tenantId, context.tenantId),
    eq(knowledgeText.id, id),
  ];

  // Check hidden flag unless explicitly allowed
  if (!context.includeHidden) {
    permissionConditions.push(eq(knowledgeText.hidden, false));
  }

  if (context.userId) {
    permissionConditions.push(
      or(
        eq(knowledgeText.userId, context.userId),
        and(isNull(knowledgeText.teamId), eq(knowledgeText.tenantWide, true)),
        exists(
          getDb()
            .select()
            .from(teamMembers)
            .where(
              and(
                eq(teamMembers.userId, context.userId),
                eq(teamMembers.teamId, knowledgeText.teamId)
              )
            )
        )
      )!
    );
  }

  if (context.teamId) {
    permissionConditions.push(eq(knowledgeText.teamId, context.teamId));
  }

  const result = await getDb()
    .select()
    .from(knowledgeText)
    .where(and(...permissionConditions));

  if (!result[0]) {
    throw new Error("Knowledge text not found or access denied");
  }

  return result[0];
};

/**
 * Get complete version history for a knowledge text entry WITHOUT text content
 * Returns all versions chronologically (oldest to newest) with metadata only
 */
export const getKnowledgeTextHistory = async (
  id: string,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
    includeHidden?: boolean;
  }
) => {
  // First get the entry to check permissions
  const entry = await getKnowledgeTextById(id, context);

  // Get all history entries for this knowledge text
  const historyEntries = await getDb()
    .select()
    .from(knowledgeTextHistory)
    .where(eq(knowledgeTextHistory.knowledgeTextId, id))
    .orderBy(desc(knowledgeTextHistory.createdAt)); // Newest first

  return historyEntries;
};

/**
 * Get a knowledgeText entry by name, category and tenantId
 */
export const getKnowledgeTextByTitle = async (filters: {
  title: string;
  tenantId: string;
}) => {
  const result = await getDb()
    .select()
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.title, filters.title),
        eq(knowledgeText.tenantId, filters.tenantId)
      )
    );
  if (result.length === 0) {
    throw new Error("Knowledge text not found");
  }
  return result[0];
};

/**
 * Update a knowledgeText entry by ID
 * Creates a history entry before updating
 */
export const updateKnowledgeText = async (
  id: string,
  data: Partial<KnowledgeTextInsert>,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
    includeHidden?: boolean;
  }
) => {
  // Get the current entry (including text) to create history
  const currentEntry = await getKnowledgeTextById(id, context);

  // check permission
  if (context.userId) {
    if (currentEntry.tenantWide) {
      await checkTenantMemberRole(context.tenantId, context.userId, [
        "admin",
        "owner",
      ]);
    } else if (currentEntry.teamId) {
      await checkTeamMemberRole(currentEntry.teamId, context.userId, ["admin"]);
    }
  }

  // Create history entry with the current state BEFORE updating
  const historyEntry: KnowledgeTextHistoryInsert = {
    knowledgeTextId: currentEntry.id,
    tenantId: currentEntry.tenantId,
    tenantWide: currentEntry.tenantWide,
    teamId: currentEntry.teamId,
    userId: currentEntry.userId,
    parentId: currentEntry.parentId,
    text: currentEntry.text,
    title: currentEntry.title,
    meta: currentEntry.meta,
    hidden: currentEntry.hidden,
  };

  await getDb().insert(knowledgeTextHistory).values(historyEntry);

  // Now update the current entry
  const updateData: Partial<KnowledgeTextInsert> = {
    ...data,
    updatedAt: sql`now()`,
  };

  const result = await getDb()
    .update(knowledgeText)
    .set(updateData)
    .where(eq(knowledgeText.id, id))
    .returning();

  if (!result[0]) {
    throw new Error("Failed to update knowledge text");
  }

  return result[0];
};

/**
 * Delete a knowledgeText entry by ID
 */
export const deleteKnowledgeText = async (
  id: string,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
    includeHidden?: boolean;
  }
) => {
  const item = await getKnowledgeTextById(id, context);

  if (context.userId) {
    if (item.tenantWide) {
      await checkTenantMemberRole(context.tenantId, context.userId, [
        "admin",
        "owner",
      ]);
    } else if (item.teamId) {
      await checkTeamMemberRole(item.teamId, context.userId, ["admin"]);
    }
  }

  // Delete the entry (history will be cascade deleted due to foreign key)
  await getDb()
    .delete(knowledgeText)
    .where(
      and(
        eq(knowledgeText.id, id),
        eq(knowledgeText.tenantId, context.tenantId)
      )
    );

  return RESPONSES.SUCCESS;
};
