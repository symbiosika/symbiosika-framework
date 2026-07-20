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
import {
  syncKnowledgeTextFileReferences,
  markKnowledgeTextFilesForCleanup,
} from "./knowledge-text-files";
import { validateFacetsForWrite, type FacetFilters } from "./facets";
import log from "../log";

/**
 * Run a post-write bookkeeping step (wikilinks, file references) without
 * letting a failure abort the surrounding create/update: the page row is
 * already written at that point, so throwing would report an error for a
 * write that actually succeeded. Failures are logged instead — the
 * bookkeeping is rebuilt from the page content on the next save anyway.
 * Mirrors the syncKnowledgeTextEmbeddingSafe pattern.
 */
export const runBookkeepingSafe = async (
  label: string,
  fn: () => Promise<unknown>
): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    log.error(`knowledgeText bookkeeping step "${label}" failed: ${error}`);
  }
};

/**
 * Postgres rejects the NUL byte (U+0000) in text/varchar columns
 * ("invalid byte sequence for encoding UTF8: 0x00"). Externally-sourced
 * content (PDF/OCR output, URL imports, uploads) occasionally contains it,
 * so every knowledgeText write path strips it centrally here instead of
 * relying on each caller. Only U+0000 is invalid in Postgres UTF-8 — other
 * control characters are storable and are deliberately kept.
 */
export const stripNullBytes = (value: string): string =>
  value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;

/** title column is varchar(1000) — longer external titles must not abort the write */
const TITLE_MAX_LENGTH = 1000;

/**
 * Make externally-sourced title/text safe to store: strip NUL bytes and
 * bound the title to the column limit. Applied by createKnowledgeText and
 * updateKnowledgeText so every ingestion path (file upload, URL import,
 * API, sync jobs) is protected without caller-side sanitizing.
 */
export const sanitizeKnowledgeTextData = <
  T extends Partial<KnowledgeTextInsert>,
>(
  data: T
): T => {
  const sanitized = { ...data };
  if (typeof sanitized.text === "string") {
    sanitized.text = stripNullBytes(sanitized.text);
  }
  if (typeof sanitized.title === "string") {
    sanitized.title = stripNullBytes(sanitized.title).slice(
      0,
      TITLE_MAX_LENGTH
    );
  }
  return sanitized;
};

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
  data = sanitizeKnowledgeTextData(data);

  // B3: reject facet values outside the tenant's controlled vocabulary.
  await validateFacetsForWrite(data.tenantId, data);

  // Audit: a freshly created page is "updated" by its creator, so default
  // updatedBy to createdBy when only the creator was provided.
  if (data.createdBy && data.updatedBy == null) {
    data = { ...data, updatedBy: data.createdBy };
  }

  // B1: a new page with content and an auto summary starts out stale, so the
  // sweeper generates its summary once it has been quiet for the debounce
  // window. Explicit/manual summaries are left as provided.
  if (
    (data.text ?? "").trim().length > 0 &&
    data.summary == null &&
    (data.summaryMode ?? "auto") === "auto"
  ) {
    data = { ...data, summaryStale: true };
  }

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

  // wikilink + file-reference bookkeeping: extract this page's outgoing
  // links and image references, and snap phantom links of other pages
  // that were waiting for this title
  const page = e[0];
  await runBookkeepingSafe("links", () => syncKnowledgeTextLinks(page));
  await runBookkeepingSafe("phantom-links", () => resolvePhantomLinks(page));
  await runBookkeepingSafe("file-references", () =>
    syncKnowledgeTextFileReferences(page)
  );

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
export const getKnowledgeText = async (
  filters: {
    tenantId: string;
    teamId?: string;
    userId?: string;
    workspaceId?: string;
    limit?: number;
    page?: number;
    includeHidden?: boolean; // Optional: include system/hidden entries
  } & FacetFilters
) => {
  // Exclude 'text' field to reduce payload size
  const permissionConditions = buildKnowledgeTextVisibilityConditions(filters);

  // B3: optional facet filters
  if (filters.pageType) {
    permissionConditions.push(eq(knowledgeText.pageType, filters.pageType));
  }
  if (filters.status) {
    permissionConditions.push(eq(knowledgeText.status, filters.status));
  }

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
 * Get the version history for a knowledge text entry (newest first).
 * Each entry is a full snapshot of a previous version, including its text,
 * blocks and change authorship (createdBy / updatedBy / versionUpdatedAt).
 *
 * Optional pagination mirrors getKnowledgeText: pass `limit` (page size) and
 * `page` (1-based); `page` only takes effect together with `limit`.
 */
export const getKnowledgeTextHistory = async (
  id: string,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
    includeHidden?: boolean;
  },
  options?: { limit?: number; page?: number }
) => {
  // First get the entry to check permissions (throws if not visible)
  await getKnowledgeTextById(id, context);

  const query = getDb()
    .select()
    .from(knowledgeTextHistory)
    .where(eq(knowledgeTextHistory.knowledgeTextId, id))
    .orderBy(desc(knowledgeTextHistory.createdAt)) // Newest first
    .$dynamic();

  if (options?.limit) {
    query.limit(options.limit);
  }
  if (options?.page && options?.limit) {
    query.offset((options.page - 1) * options.limit);
  }

  return await query;
};

/**
 * Get a single history version of a knowledge text entry by its history id,
 * with full content. Access is checked against the parent page, and the
 * version must belong to that page (and the caller's tenant).
 */
export const getKnowledgeTextHistoryVersion = async (
  id: string,
  historyId: string,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
    includeHidden?: boolean;
  }
) => {
  // Permission check against the parent page (throws if not visible)
  await getKnowledgeTextById(id, context);

  const result = await getDb()
    .select()
    .from(knowledgeTextHistory)
    .where(
      and(
        eq(knowledgeTextHistory.id, historyId),
        eq(knowledgeTextHistory.knowledgeTextId, id),
        eq(knowledgeTextHistory.tenantId, context.tenantId)
      )
    );

  if (!result[0]) {
    throw new Error("Knowledge text history version not found");
  }

  return result[0];
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

  // B3: reject facet values outside the tenant's controlled vocabulary.
  await validateFacetsForWrite(context.tenantId, data);

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
    // audit snapshot of the version being archived
    createdBy: currentEntry.createdBy,
    updatedBy: currentEntry.updatedBy,
    versionUpdatedAt: currentEntry.updatedAt,
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
  const updateData: Partial<KnowledgeTextInsert> = sanitizeKnowledgeTextData({
    ...data,
  });

  // Audit: createdBy is immutable after creation, and updatedBy always
  // reflects who performed this change (never a client-supplied value).
  delete updateData.createdBy;
  if (context.userId) {
    updateData.updatedBy = context.userId;
  } else {
    delete updateData.updatedBy;
  }

  // B1: a content change marks the summary stale so the debounced sweeper
  // regenerates it once the page goes quiet. Respect an explicit summaryStale
  // in the update (e.g. a manual summary edit clearing it).
  if (updateData.text !== undefined && updateData.summaryStale === undefined) {
    updateData.summaryStale = true;
  }

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

  // wikilink + file-reference bookkeeping
  const updatedPage = result[0];
  if (data.text !== undefined) {
    await runBookkeepingSafe("links", () =>
      syncKnowledgeTextLinks(updatedPage)
    );
    await runBookkeepingSafe("file-references", () =>
      syncKnowledgeTextFileReferences(updatedPage)
    );
  }
  if (data.title !== undefined && data.title !== currentEntry.title) {
    await runBookkeepingSafe("phantom-links", () =>
      resolvePhantomLinks(updatedPage)
    );
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

  // files exclusively referenced by this page get a grace-period expiry
  // for the cleanup cron (reference rows cascade with the page)
  await markKnowledgeTextFilesForCleanup(item.id);

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
