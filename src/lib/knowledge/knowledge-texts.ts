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

  // If parentId is provided, resolve it to documentId
  // This ensures hierarchy is maintained across versions
  let resolvedParentId = data.parentId;
  if (data.parentId) {
    const parentEntry = await getDb()
      .select({ documentId: knowledgeText.documentId })
      .from(knowledgeText)
      .where(eq(knowledgeText.id, data.parentId))
      .limit(1);
    
    if (parentEntry[0]) {
      resolvedParentId = parentEntry[0].documentId;
    }
  }

  // documentId will be auto-generated if not provided (default in schema)
  const e = await getDb()
    .insert(knowledgeText)
    .values({
      ...data,
      parentId: resolvedParentId,
      version: 1,
      isLatest: true,
    })
    .returning();
  if (!e[0]) {
    throw new Error("Failed to create knowledge text");
  }
  return e[0];
};

/**
 * Get list of all knowledge text entries - returns only latest versions WITHOUT text content
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
  // For list queries: Get all entries with isLatest=true (latest versions)
  // Only the latest version has isLatest=true
  // Exclude 'text' field to reduce payload size
  const permissionConditions: SQLWrapper[] = [
    eq(knowledgeText.tenantId, filters.tenantId),
    eq(knowledgeText.isLatest, true), // Only show latest versions
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
 * Returns latest version by default, or specific version if versionId is provided
 */
export const getKnowledgeTextById = async (
  id: string,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
    versionId?: string; // Optional: get specific version instead of latest
    includeHidden?: boolean; // Optional: include system/hidden entries
  }
) => {
  // If versionId is provided, get that specific version
  if (context.versionId) {
    const permissionConditions: SQLWrapper[] = [
      eq(knowledgeText.tenantId, context.tenantId),
      eq(knowledgeText.id, context.versionId),
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
      throw new Error("Knowledge text version not found or access denied");
    }

    return result[0];
  }

  // Otherwise, find the latest version (isLatest=true) for this documentId
  // First, get the entry to determine its documentId
  const entry = await getDb()
    .select()
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.id, id),
        eq(knowledgeText.tenantId, context.tenantId)
      )
    );

  if (!entry[0]) {
    throw new Error("Knowledge text not found");
  }

  const documentId = entry[0].documentId;

  // Now find the latest version (isLatest=true) for this documentId
  const permissionConditions: SQLWrapper[] = [
    eq(knowledgeText.tenantId, context.tenantId),
    eq(knowledgeText.documentId, documentId),
    eq(knowledgeText.isLatest, true),
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
    .where(and(...permissionConditions))
    .orderBy(desc(knowledgeText.version))
    .limit(1);

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
  // First get the entry to check permissions and find documentId
  const entry = await getDb()
    .select()
    .from(knowledgeText)
    .where(
      and(eq(knowledgeText.id, id), eq(knowledgeText.tenantId, context.tenantId))
    );

  if (!entry[0]) {
    throw new Error("Knowledge text not found");
  }

  const documentId = entry[0].documentId;

  // Get all versions that belong to this documentId
  const permissionConditions: SQLWrapper[] = [
    eq(knowledgeText.tenantId, context.tenantId),
    eq(knowledgeText.documentId, documentId),
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

  // Return all versions WITHOUT text content, ordered chronologically (oldest first)
  const { text, ...rest } = getTableColumns(knowledgeText);
  return await getDb()
    .select({ ...rest })
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
    includeHidden?: boolean;
  }
) => {
  // Get the full entry (including text) to create new version
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

  // If parentId is being updated and is not null, resolve it to documentId
  let resolvedParentId = data.parentId !== undefined ? data.parentId : currentEntry.parentId;
  if (data.parentId !== undefined && data.parentId !== null) {
    const parentEntry = await getDb()
      .select({ documentId: knowledgeText.documentId })
      .from(knowledgeText)
      .where(eq(knowledgeText.id, data.parentId))
      .limit(1);
    
    if (parentEntry[0]) {
      resolvedParentId = parentEntry[0].documentId;
    }
  }

  // Create new version with incremented version number
  const newVersion: KnowledgeTextInsert = {
    documentId: currentEntry.documentId, // Keep same documentId
    tenantId: currentEntry.tenantId,
    tenantWide: currentEntry.tenantWide,
    teamId: currentEntry.teamId,
    userId: currentEntry.userId,
    parentId: resolvedParentId, // Keep Wiki hierarchy (NOT version chain!) - allow updates
    text: data.text ?? currentEntry.text,
    title: data.title ?? currentEntry.title,
    meta: data.meta ?? currentEntry.meta,
    version: currentEntry.version + 1,
    isLatest: true, // New version is always latest
    hidden: data.hidden ?? currentEntry.hidden, // Keep hidden status
  };

  // Use transaction to ensure atomicity
  // First insert new version, then mark old version as not latest
  // This ensures we don't lose the current version if the insert fails
  const e = await getDb().insert(knowledgeText).values(newVersion).returning();

  if (!e[0]) {
    throw new Error("Failed to create new version of knowledge text");
  }

  // Only mark old version as not latest AFTER successful insert
  await getDb()
    .update(knowledgeText)
    .set({ isLatest: false })
    .where(eq(knowledgeText.id, currentEntry.id));

  return e[0];
};

/**
 * Delete a knowledgeText entry by ID
 * Deletes ALL versions with the same documentId (cascade delete in both directions)
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

  // Delete ALL versions with the same documentId (cascade in both directions)
  await getDb()
    .delete(knowledgeText)
    .where(
      and(
        eq(knowledgeText.documentId, item.documentId),
        eq(knowledgeText.tenantId, context.tenantId)
      )
    );

  return RESPONSES.SUCCESS;
};
