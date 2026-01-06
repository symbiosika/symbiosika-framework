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

  const e = await getDb().insert(knowledgeText).values(data).returning();
  if (!e[0]) {
    throw new Error("Failed to create knowledge text");
  }
  return e[0];
};

/**
 * Get list of all knowledge text entries - returns only latest versions WITHOUT text content
 */
export const getKnowledgeText = async (filters: {
  tenantId: string;
  teamId?: string;
  userId?: string;
  workspaceId?: string;
  limit?: number;
  page?: number;
}) => {
  // For list queries: Get all entries with hidden=false (latest versions)
  // After versioning, only the latest version has hidden=false
  // Exclude 'text' field to reduce payload size
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

  const { text, ...rest } = getTableColumns(knowledgeText); // exclude "text" column
  const query = getDb()
    .select({ ...rest })
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
  }
) => {
  // If versionId is provided, get that specific version
  if (context.versionId) {
    const permissionConditions: SQLWrapper[] = [
      eq(knowledgeText.tenantId, context.tenantId),
      eq(knowledgeText.id, context.versionId),
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

    const result = await getDb()
      .select()
      .from(knowledgeText)
      .where(and(...permissionConditions));

    if (!result[0]) {
      throw new Error("Knowledge text version not found or access denied");
    }

    return result[0];
  }

  // Otherwise, find the latest version (hidden=false) that belongs to this entry chain
  // First, get the entry to determine if it's a root or has a parent
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

  const rootId = entry[0].parentId ?? id;

  // Now find the latest version (hidden=false) in this chain
  const permissionConditions: SQLWrapper[] = [
    eq(knowledgeText.tenantId, context.tenantId),
    eq(knowledgeText.hidden, false),
    or(
      eq(knowledgeText.id, rootId), // The root itself if it's the latest
      eq(knowledgeText.parentId, rootId) // Or any child pointing to root
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
  }
) => {
  // First get the entry to check permissions and find root
  const entry = await getDb()
    .select()
    .from(knowledgeText)
    .where(
      and(eq(knowledgeText.id, id), eq(knowledgeText.tenantId, context.tenantId))
    );

  if (!entry[0]) {
    throw new Error("Knowledge text not found");
  }

  // Find the root entry (the one without parentId or the entry itself)
  const rootId = entry[0].parentId ?? id;

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

  const e = await getDb().insert(knowledgeText).values(newVersion).returning();

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

  await getDb().delete(knowledgeText).where(eq(knowledgeText.id, id));

  return RESPONSES.SUCCESS;
};
