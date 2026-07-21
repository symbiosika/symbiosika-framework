/**
 * Context-economy helpers for agents working the knowledge base.
 *
 * These sit on top of the page CRUD and are built for cheap, oriented access:
 *   - resolvePageByTitle  — find a page by exact title (page link semantics)
 *   - listRecentChanges   — "what's new", sorted by updatedAt, filterable
 *   - getPagesBatch       — read several pages in one call
 *   - appendToKnowledgeText — append without a read-modify-write round trip
 *
 * All of them go through the existing visibility mechanics
 * (buildKnowledgeTextVisibilityConditions / getKnowledgeTextById): pages the
 * caller may not see are indistinguishable from non-existent ones.
 */

import { and, desc, eq, gte, inArray, isNull, sql, getTableColumns } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import {
  buildKnowledgeTextVisibilityConditions,
  getKnowledgeTextById,
  updateKnowledgeText,
} from "./knowledge-texts";
import type { FacetFilters } from "./facets";

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

/** A page reference without the full text (for lists / resolution). */
const listColumns = () => {
  const { text, ...rest } = getTableColumns(knowledgeText);
  return rest;
};

/**
 * resolve a page by exact title, case-insensitively, using the same
 * semantics as the page link resolver. Returns the visible page (without text)
 * or null. On multiple case-insensitive matches the first by title is
 * returned, deterministically.
 */
export const resolvePageByTitle = async (
  title: string,
  context: Context
): Promise<Record<string, unknown> | null> => {
  const conditions = buildKnowledgeTextVisibilityConditions(context);
  conditions.push(sql`lower(${knowledgeText.title}) = lower(${title})`);

  const rows = await getDb()
    .select(listColumns())
    .from(knowledgeText)
    .where(and(...conditions))
    .orderBy(knowledgeText.title, knowledgeText.createdAt)
    .limit(1);

  return rows[0] ?? null;
};

/**
 * Compute the set of descendant page ids (including the root) for a subtree,
 * restricted to pages visible to the caller. Used to scope recent-changes to a
 * subtree without a recursive SQL CTE.
 */
const getVisibleSubtreeIds = async (
  rootId: string,
  context: Context
): Promise<string[]> => {
  const rows = await getDb()
    .select({ id: knowledgeText.id, parentId: knowledgeText.parentId })
    .from(knowledgeText)
    .where(and(...buildKnowledgeTextVisibilityConditions(context)));

  const childrenByParent = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const arr = childrenByParent.get(r.parentId) ?? [];
    arr.push(r.id);
    childrenByParent.set(r.parentId, arr);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child);
  }
  return result;
};

export interface RecentChangesOptions extends FacetFilters {
  /** ISO timestamp; only pages updated at or after this are returned. */
  since?: string;
  /** Restrict to a subtree (this page id and all its descendants). */
  parentId?: string;
  limit?: number;
}

/**
 * recent changes — visible pages sorted by `updatedAt` (newest first),
 * without text. Filterable by time window, subtree, team (via context) and
 * facets. Each item carries summary + facets + updatedAt + updatedBy so an
 * agent can triage "what's new" in one call.
 */
export const listRecentChanges = async (
  context: Context,
  options: RecentChangesOptions = {}
): Promise<Record<string, unknown>[]> => {
  const conditions = buildKnowledgeTextVisibilityConditions(context);

  if (options.since) {
    conditions.push(gte(knowledgeText.updatedAt, options.since));
  }
  if (options.pageType) {
    conditions.push(eq(knowledgeText.pageType, options.pageType));
  }
  if (options.status) {
    conditions.push(eq(knowledgeText.status, options.status));
  }
  if (options.parentId) {
    const subtreeIds = await getVisibleSubtreeIds(options.parentId, context);
    if (subtreeIds.length === 0) return [];
    conditions.push(inArray(knowledgeText.id, subtreeIds));
  }

  const query = getDb()
    .select(listColumns())
    .from(knowledgeText)
    .where(and(...conditions))
    .orderBy(desc(knowledgeText.updatedAt))
    .limit(Math.min(options.limit ?? 50, 200));

  return await query;
};

export interface BatchReadOptions {
  /** When true, include the full text; otherwise only list columns. */
  includeText?: boolean;
}

/**
 * read several pages in one call. Silently drops ids the caller cannot see
 * (visibility) — the returned array only contains visible pages, in the order
 * the ids were given.
 */
export const getPagesBatch = async (
  ids: string[],
  context: Context,
  options: BatchReadOptions = {}
): Promise<Record<string, unknown>[]> => {
  if (ids.length === 0) return [];
  const uniqueIds = Array.from(new Set(ids));

  const conditions = buildKnowledgeTextVisibilityConditions(context);
  conditions.push(inArray(knowledgeText.id, uniqueIds));

  const columns = options.includeText
    ? getTableColumns(knowledgeText)
    : listColumns();

  const rows = (await getDb()
    .select(columns)
    .from(knowledgeText)
    .where(and(...conditions))) as Array<Record<string, unknown>>;

  // Preserve the requested order.
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is Record<string, unknown> => r !== undefined);
};

export interface AppendResult {
  id: string;
  appendedChars: number;
  totalChars: number;
}

/**
 * append text to a page without the caller doing a read-modify-write and
 * without returning the (potentially large) full content. Goes through
 * updateKnowledgeText so history, permissions, page link/file bookkeeping and
 * summary-stale marking all behave exactly like a normal edit.
 */
export const appendToKnowledgeText = async (
  id: string,
  appendText: string,
  context: Context,
  options: { separator?: string } = {}
): Promise<AppendResult> => {
  const current = await getKnowledgeTextById(id, context);
  const separator = options.separator ?? "\n\n";
  const base = current.text ?? "";
  const newText = base.length > 0 ? `${base}${separator}${appendText}` : appendText;

  const updated = await updateKnowledgeText(id, { text: newText }, context);

  return {
    id,
    appendedChars: appendText.length,
    totalChars: updated.text.length,
  };
};
