import { and, asc, desc, eq, or, isNull, type SQLWrapper, exists, sql } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  knowledgeText,
  type KnowledgeTextInsert,
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

  const e = await getDb().insert(knowledgeText).values(data).returning();
  if (!e[0]) {
    throw new Error("Failed to create knowledge text");
  }
  return e[0];
};

/**
 * Read all knowledgeText entries - returns only the latest version of each entry
 * If id is provided, returns only that specific entry (not the history)
 */
export const getKnowledgeText = async (filters: {
  id?: string;
  tenantId: string;
  teamId?: string;
  userId?: string;
  workspaceId?: string;
  limit?: number;
  page?: number;
}) => {
  // If specific ID is requested, return only that entry
  if (filters.id) {
    const permissionConditions: SQLWrapper[] = [
      eq(knowledgeText.tenantId, filters.tenantId),
      eq(knowledgeText.id, filters.id),
    ];

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

    return await getDb()
      .select()
      .from(knowledgeText)
      .where(and(...permissionConditions));
  }

  // For list queries: Get all entries with hidden=false (latest versions)
  // After versioning, only the latest version has hidden=false
  const permissionConditions: SQLWrapper[] = [
    eq(knowledgeText.tenantId, filters.tenantId),
    eq(knowledgeText.hidden, false), // Only show non-hidden (latest) versions
  ];

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

  const query = getDb()
    .select()
    .from(knowledgeText)
    .where(and(...permissionConditions))
    .orderBy(desc(knowledgeText.createdAt))
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
 * Get complete version history for a knowledge text entry
 * Returns all versions chronologically (oldest to newest)
 */
export const getKnowledgeTextHistory = async (
  id: string,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
  }
) => {
  // First check if user has permission to access this entry
  const entry = await getKnowledgeText({
    id,
    tenantId: context.tenantId,
    userId: context.userId,
    teamId: context.teamId,
    workspaceId: context.workspaceId,
  });

  if (!entry[0]) {
    throw new Error("Knowledge text not found or access denied");
  }

  const currentEntry = entry[0];
  
  // Find the root entry (the one without parentId or the entry itself)
  const rootId = currentEntry.parentId ?? id;

  // Get all versions that belong to this entry chain
  // This includes the root and all entries that have this root as parentId
  const permissionConditions: SQLWrapper[] = [
    eq(knowledgeText.tenantId, context.tenantId),
    or(
      eq(knowledgeText.id, rootId), // The root entry
      eq(knowledgeText.parentId, rootId) // All versions pointing to root
    )!,
  ];

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

  // Return all versions ordered chronologically (oldest first)
  return await getDb()
    .select()
    .from(knowledgeText)
    .where(and(...permissionConditions))
    .orderBy(asc(knowledgeText.version), asc(knowledgeText.createdAt));
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
 * Creates a new version instead of overwriting the existing entry
 */
export const updateKnowledgeText = async (
  id: string,
  data: Partial<KnowledgeTextInsert>,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
  }
) => {
  // First check if user has permission to update this entry
  const existing = await getKnowledgeText({
    id,
    tenantId: context.tenantId,
    userId: context.userId,
    teamId: context.teamId,
    workspaceId: context.workspaceId,
  });

  if (!existing[0]) {
    throw new Error("Knowledge text not found or access denied");
  }

  const currentEntry = existing[0];

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

  // Mark current entry as hidden (old version)
  await getDb()
    .update(knowledgeText)
    .set({ hidden: true })
    .where(eq(knowledgeText.id, id));

  // Create new version with incremented version number
  const newVersion: KnowledgeTextInsert = {
    tenantId: currentEntry.tenantId,
    tenantWide: currentEntry.tenantWide,
    teamId: currentEntry.teamId,
    userId: currentEntry.userId,
    text: data.text ?? currentEntry.text,
    title: data.title ?? currentEntry.title,
    meta: data.meta ?? currentEntry.meta,
    version: (data.version ?? currentEntry.version) + 1,
    hidden: data.hidden ?? false,
    parentId: currentEntry.parentId ?? id, // Link to previous version or original parent
  };

  const e = await getDb()
    .insert(knowledgeText)
    .values(newVersion)
    .returning();

  if (!e[0]) {
    throw new Error("Failed to create new version of knowledge text");
  }
  return e[0];
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
  }
) => {
  const e = await getKnowledgeText({
    id,
    tenantId: context.tenantId,
    userId: context.userId,
    teamId: context.teamId,
    workspaceId: context.workspaceId,
  });

  if (!e[0]) {
    throw new Error("Knowledge text not found");
  }

  if (context.userId) {
    const item = e[0];
    if (item.tenantWide) {
      await checkTenantMemberRole(context.tenantId, context.userId, [
        "admin",
        "owner",
      ]);
    } else if (item.teamId) {
      await checkTeamMemberRole(item.teamId, context.userId, ["admin"]);
    }
  }

  await getDb().delete(knowledgeText).where(eq(knowledgeText.id, id));

  return RESPONSES.SUCCESS;
};
