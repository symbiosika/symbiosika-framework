/**
 * Wiki path resolution: the breadcrumb of a knowledgeText page in the tree.
 *
 * A page's "location" in the wiki is implicit in its `parentId` chain — there
 * is no stored path column. This module derives the slash-separated path
 * (root → page) by walking the ancestor chain, so retrieval responses can tell
 * an agent WHERE a chunk / page lives, not just its bare title.
 *
 * The ancestors are loaded level by level (one query per tree depth, and wiki
 * trees are shallow) rather than pulling the whole tenant tree, so resolving a
 * handful of search hits stays cheap. Everything is scoped by `tenantId`; a
 * broken/cross-tenant `parentId` simply ends the chain.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";

/** One step of a wiki path, root-first. */
export type KnowledgeTextPathSegment = { id: string; title: string };

export type KnowledgeTextPath = {
  /** ancestor + self titles, root first, joined by the separator (default "/") */
  path: string;
  /** the same segments as ids, root first */
  pathIds: string[];
  /** the same segments as { id, title }, root first */
  pathSegments: KnowledgeTextPathSegment[];
};

const DEFAULT_SEPARATOR = "/";

/**
 * Resolve the wiki path for each of the given page ids in one pass.
 *
 * Returns a Map keyed by the requested page id. Ids that do not resolve to a
 * visible page in the tenant are omitted from the map (the caller decides how
 * to represent "no path").
 *
 * @param options.includeSelf  include the page itself as the last segment
 *                              (default true); false yields only the ancestors
 *                              ("the folders it lives in").
 * @param options.separator    string used to join titles (default "/").
 */
export const resolveKnowledgeTextPaths = async (
  ids: string[],
  tenantId: string,
  options: { includeSelf?: boolean; separator?: string } = {}
): Promise<Map<string, KnowledgeTextPath>> => {
  const includeSelf = options.includeSelf ?? true;
  const separator = options.separator ?? DEFAULT_SEPARATOR;

  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return new Map();

  // Load the requested nodes and then their ancestors, one tree level per
  // query, until no unseen parents remain. Wiki trees are shallow, so this is
  // a few small queries rather than a scan of the whole tenant tree.
  const nodes = new Map<
    string,
    { id: string; parentId: string | null; title: string }
  >();
  let frontier = uniqueIds;
  while (frontier.length > 0) {
    const missing = frontier.filter((id) => !nodes.has(id));
    if (missing.length === 0) break;
    const rows = await getDb()
      .select({
        id: knowledgeText.id,
        parentId: knowledgeText.parentId,
        title: knowledgeText.title,
      })
      .from(knowledgeText)
      .where(
        and(eq(knowledgeText.tenantId, tenantId), inArray(knowledgeText.id, missing))
      );
    for (const row of rows) nodes.set(row.id, row);
    frontier = rows
      .map((r) => r.parentId)
      .filter((id): id is string => !!id);
  }

  const result = new Map<string, KnowledgeTextPath>();
  for (const startId of uniqueIds) {
    if (!nodes.has(startId)) continue;

    // Walk up to the root, guarding against a cyclic parentId.
    const segments: KnowledgeTextPathSegment[] = [];
    const seen = new Set<string>();
    let current = nodes.get(startId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      segments.push({ id: current.id, title: current.title });
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    segments.reverse(); // root first

    if (!includeSelf) segments.pop();

    result.set(startId, {
      path: segments.map((s) => s.title).join(separator),
      pathIds: segments.map((s) => s.id),
      pathSegments: segments,
    });
  }

  return result;
};

/** Convenience wrapper for a single page. Returns null when it does not resolve. */
export const resolveKnowledgeTextPath = async (
  id: string,
  tenantId: string,
  options: { includeSelf?: boolean; separator?: string } = {}
): Promise<KnowledgeTextPath | null> => {
  const map = await resolveKnowledgeTextPaths([id], tenantId, options);
  return map.get(id) ?? null;
};
