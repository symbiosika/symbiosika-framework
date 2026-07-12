/**
 * LLM-friendly simplified view of knowledgeText wiki pages.
 *
 * Returns a page reduced to `{ id, title, content }`, where `content` is the
 * page's full text: for block pages this is the materialized `text` cache
 * (all blocks merged to markdown), for legacy pages the plain text — so a
 * consumer never has to deal with the block structure.
 *
 * With `recursive: true` the page's sub-pages (wiki tree via `parentId`) are
 * nested under `children`, ordered like the wiki sidebar (manual `position`
 * first, then title). Pages the caller is not allowed to see are silently
 * omitted together with their subtrees.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import {
  getKnowledgeTextById,
  buildKnowledgeTextVisibilityConditions,
} from "./knowledge-texts";

export type SimplifiedKnowledgeText = {
  id: string;
  title: string;
  content: string;
  /** only present when requested with `recursive: true` */
  children?: SimplifiedKnowledgeText[];
};

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

type PageRow = {
  id: string;
  title: string;
  text: string;
  parentId: string | null;
  position: string | null;
};

/** Wiki sidebar order: manual position first (nulls last), then title */
const byWikiOrder = (a: PageRow, b: PageRow): number => {
  if (a.position !== null && b.position !== null) {
    if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  } else if (a.position !== b.position) {
    return a.position !== null ? -1 : 1;
  }
  return a.title.localeCompare(b.title);
};

/**
 * Get a page as `{ id, title, content }`. With `recursive: true` the whole
 * subtree is included as nested `children`.
 */
export const getSimplifiedKnowledgeText = async (
  id: string,
  context: Context,
  options?: { recursive?: boolean }
): Promise<SimplifiedKnowledgeText> => {
  // permission check for the root (throws if not visible)
  const root = await getKnowledgeTextById(id, context);

  if (!options?.recursive) {
    return { id: root.id, title: root.title, content: root.text };
  }

  // One query for every page the caller may see in this tenant; the tree is
  // assembled in memory. This avoids N+1 queries per tree level and makes
  // cycle protection trivial.
  const rows: PageRow[] = await getDb()
    .select({
      id: knowledgeText.id,
      title: knowledgeText.title,
      text: knowledgeText.text,
      parentId: knowledgeText.parentId,
      position: knowledgeText.position,
    })
    .from(knowledgeText)
    .where(and(...buildKnowledgeTextVisibilityConditions(context)));

  const byParent = new Map<string, PageRow[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const siblings = byParent.get(row.parentId) ?? [];
    siblings.push(row);
    byParent.set(row.parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort(byWikiOrder);
  }

  const visited = new Set<string>();
  const buildNode = (row: PageRow): SimplifiedKnowledgeText => {
    visited.add(row.id);
    const children = (byParent.get(row.id) ?? [])
      .filter((child) => !visited.has(child.id)) // cycle protection
      .map(buildNode);
    return {
      id: row.id,
      title: row.title,
      content: row.text,
      children,
    };
  };

  return buildNode({
    id: root.id,
    title: root.title,
    text: root.text,
    parentId: root.parentId,
    position: root.position,
  });
};
