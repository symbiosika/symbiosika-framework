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
  /** A5: content was cut to stay within the maxChars budget. */
  contentTruncated?: boolean;
  /** A5: this node has children that were not expanded due to maxDepth. */
  childrenOmitted?: boolean;
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
  options?: {
    recursive?: boolean;
    /** A5: maximum subtree depth (root = 0). Deeper nodes are not expanded. */
    maxDepth?: number;
    /** A5: total character budget across all node contents. */
    maxChars?: number;
  }
): Promise<SimplifiedKnowledgeText> => {
  // permission check for the root (throws if not visible)
  const root = await getKnowledgeTextById(id, context);

  // A5: apply the char budget to a single node's content, truncating
  // explicitly (never silently) and reporting how much budget is left.
  const applyCharBudget = (
    content: string,
    remaining: number | undefined
  ): { content: string; truncated: boolean; remaining: number | undefined } => {
    if (remaining === undefined) return { content, truncated: false, remaining };
    if (remaining <= 0) return { content: "", truncated: true, remaining: 0 };
    if (content.length > remaining) {
      return {
        content: content.slice(0, remaining),
        truncated: true,
        remaining: 0,
      };
    }
    return { content, truncated: false, remaining: remaining - content.length };
  };

  if (!options?.recursive) {
    const { content, truncated } = applyCharBudget(root.text, options?.maxChars);
    return {
      id: root.id,
      title: root.title,
      content,
      ...(truncated ? { contentTruncated: true } : {}),
    };
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
  let remainingChars = options.maxChars;
  const buildNode = (row: PageRow, depth: number): SimplifiedKnowledgeText => {
    visited.add(row.id);

    const budgeted = applyCharBudget(row.text, remainingChars);
    remainingChars = budgeted.remaining;

    const availableChildren = (byParent.get(row.id) ?? []).filter(
      (child) => !visited.has(child.id) // cycle protection
    );

    const node: SimplifiedKnowledgeText = {
      id: row.id,
      title: row.title,
      content: budgeted.content,
    };
    if (budgeted.truncated) node.contentTruncated = true;

    // A5: stop expanding beyond maxDepth, but flag that children exist.
    if (
      options.maxDepth !== undefined &&
      depth >= options.maxDepth &&
      availableChildren.length > 0
    ) {
      node.childrenOmitted = true;
      node.children = [];
      return node;
    }

    node.children = availableChildren.map((child) => buildNode(child, depth + 1));
    return node;
  };

  return buildNode(
    {
      id: root.id,
      title: root.title,
      text: root.text,
      parentId: root.parentId,
      position: root.position,
    },
    0
  );
};
