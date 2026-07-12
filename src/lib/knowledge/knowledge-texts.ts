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
  knowledgeTextBlock,
  knowledgeTextHistory,
  knowledgeEntry,
  type KnowledgeTextInsert,
  type KnowledgeTextHistoryInsert,
} from "../db/schema/knowledge";
import { RESPONSES } from "../responses";
import { teamMembers } from "../db/schema/users";
import { checkTenantMemberRole } from "../usermanagement/tenants";
import { checkTeamMemberRole } from "../usermanagement/teams";
import { syncKnowledgeTextEmbeddingSafe } from "./knowledge-text-embedding";
import {
  syncKnowledgeTextLinks,
  resolvePhantomLinks,
} from "./knowledge-text-links";

/**
 * Central write-permission rule for knowledgeText pages:
 *
 *   - the assigned user (owner) may always read and write
 *   - team pages: every team member may read and write
 *   - tenant-wide pages: every tenant member may read and write
 *   - private pages of another user are off limits
 *
 * Mirrors the read rule in buildKnowledgeTextVisibilityConditions (team
 * membership takes precedence over the tenant-wide flag). Contexts without
 * a userId are internal/service calls and skip the check, matching all
 * other knowledgeText operations.
 */
export const checkKnowledgeTextWritePermission = async (
  page: {
    tenantId: string;
    tenantWide: boolean;
    teamId: string | null;
    userId: string | null;
  },
  context: { tenantId: string; userId?: string }
): Promise<void> => {
  if (!context.userId) return;
  if (page.userId && page.userId === context.userId) return; // owner
  if (page.teamId) {
    await checkTeamMemberRole(page.teamId, context.userId, [
      "member",
      "admin",
    ]);
    return;
  }
  if (page.tenantWide) {
    await checkTenantMemberRole(page.tenantId, context.userId, [
      "member",
      "admin",
      "owner",
    ]);
    return;
  }
  throw new Error("Knowledge text not found or access denied");
};

/**
 * Create a new knowledgeText entry
 */
export const createKnowledgeText = async (data: KnowledgeTextInsert) => {
  // creating a page inside a team / tenant-wide requires access to that
  // container (ownership alone is not enough here)
  if (data.userId && data.teamId) {
    await checkTeamMemberRole(data.teamId, data.userId, ["member", "admin"]);
  } else if (data.userId && data.tenantWide) {
    await checkTenantMemberRole(data.tenantId, data.userId, [
      "member",
      "admin",
      "owner",
    ]);
  }

  const e = await getDb()
    .insert(knowledgeText)
    .values(data)
    .returning();
  if (!e[0]) {
    throw new Error("Failed to create knowledge text");
  }

  // wikilink bookkeeping: extract this page's outgoing links and snap
  // phantom links of other pages that were waiting for this title
  await syncKnowledgeTextLinks(e[0]);
  await resolvePhantomLinks(e[0]);

  // initial embedding sync for pages created with embedding already on
  if (e[0].embeddingEnabled) {
    const syncResult = await syncKnowledgeTextEmbeddingSafe(
      e[0].id,
      e[0].tenantId
    );
    if (syncResult?.synced) {
      // the sync wrote knowledgeEntryId/meta — return the fresh row
      const fresh = await getDb()
        .select()
        .from(knowledgeText)
        .where(eq(knowledgeText.id, e[0].id));
      return fresh[0] ?? e[0];
    }
  }

  return e[0];
};

/**
 * Build the WHERE conditions that decide which knowledgeText entries are
 * visible in a given context (tenant, hidden flag, user/team access).
 * Shared by every read path so the visibility rules cannot drift apart.
 */
export const buildKnowledgeTextVisibilityConditions = (filters: {
  tenantId: string;
  teamId?: string;
  userId?: string;
  includeHidden?: boolean;
}): SQLWrapper[] => {
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

  return permissionConditions;
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
  const permissionConditions = buildKnowledgeTextVisibilityConditions(filters);

  const { text, ...rest } = getTableColumns(knowledgeText); // exclude "text" column
  const query = getDb()
    .select({ ...rest })
    .from(knowledgeText)
    .where(and(...permissionConditions))
    // manual wiki order first (NULLs last in PG), then alphabetically
    .orderBy(asc(knowledgeText.position), asc(knowledgeText.title))
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
    ...buildKnowledgeTextVisibilityConditions(context),
    eq(knowledgeText.id, id),
  ];

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

  await checkKnowledgeTextWritePermission(currentEntry, context);

  // moving a page into a team or making it tenant-wide additionally
  // requires access to the TARGET container
  if (context.userId) {
    if (data.teamId && data.teamId !== currentEntry.teamId) {
      await checkTeamMemberRole(data.teamId, context.userId, [
        "member",
        "admin",
      ]);
    }
    if (data.tenantWide === true && !currentEntry.tenantWide) {
      await checkTenantMemberRole(context.tenantId, context.userId, [
        "member",
        "admin",
        "owner",
      ]);
    }
  }

  // For block pages, snapshot the blocks alongside the text so history
  // entries stay restorable
  const currentBlocks =
    currentEntry.contentMode === "blocks"
      ? await getDb()
          .select()
          .from(knowledgeTextBlock)
          .where(eq(knowledgeTextBlock.knowledgeTextId, currentEntry.id))
          .orderBy(asc(knowledgeTextBlock.position))
      : [];

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
    contentMode: currentEntry.contentMode,
    blocks:
      currentEntry.contentMode === "blocks"
        ? currentBlocks.map((b) => ({
            id: b.id,
            type: b.type,
            content: b.content,
            position: b.position,
            meta: (b.meta ?? {}) as Record<string, unknown>,
          }))
        : null,
  };

  await getDb().insert(knowledgeTextHistory).values(historyEntry);

  // Now update the current entry
  const updateData: Partial<KnowledgeTextInsert> = {
    ...data,
  };

  const result = await getDb()
    .update(knowledgeText)
    .set({
      ...updateData,
      updatedAt: sql`now()`,
    })
    .where(eq(knowledgeText.id, id))
    .returning();

  if (!result[0]) {
    throw new Error("Failed to update knowledge text");
  }

  // wikilink bookkeeping
  if (data.text !== undefined) {
    await syncKnowledgeTextLinks(result[0]);
  }
  if (data.title !== undefined && data.title !== currentEntry.title) {
    await resolvePhantomLinks(result[0]);
  }

  // Keep the RAG mirror in sync: covers newly enabled embedding, changed
  // content, and cleanup after embedding was turned off. No-op otherwise;
  // failures are logged and never fail the update itself.
  if (result[0].embeddingEnabled || currentEntry.knowledgeEntryId) {
    const syncResult = await syncKnowledgeTextEmbeddingSafe(
      result[0].id,
      result[0].tenantId
    );
    if (syncResult && (syncResult.synced || syncResult.removed)) {
      // the sync wrote knowledgeEntryId/meta — return the fresh row
      return await getKnowledgeTextById(id, { ...context, includeHidden: true });
    }
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

  await checkKnowledgeTextWritePermission(item, context);

  // Delete the entry (history and blocks are cascade deleted via FKs)
  await getDb()
    .delete(knowledgeText)
    .where(
      and(
        eq(knowledgeText.id, id),
        eq(knowledgeText.tenantId, context.tenantId)
      )
    );

  // Clean up the RAG mirror created by the embedding sync (the FK points
  // from knowledge_text to knowledge_entry, so it does not cascade)
  if (item.knowledgeEntryId) {
    await getDb()
      .delete(knowledgeEntry)
      .where(
        and(
          eq(knowledgeEntry.id, item.knowledgeEntryId),
          eq(knowledgeEntry.tenantId, context.tenantId)
        )
      );
  }

  return RESPONSES.SUCCESS;
};
