/**
 * Chunk context of a page: the chunk at `order` plus its neighbours
 * (before/after), in reading order. Lets an agent reload the context a
 * single search snippet has lost.
 *
 * The chunks belong to the knowledge_entry the page is mirrored into once
 * embedding is enabled (knowledgeText.knowledgeEntryId). The knowledgeEntryId
 * is derived from the visible page — page visibility == chunk visibility.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeChunks } from "../db/schema/knowledge";
import { getKnowledgeTextById } from "./knowledge-texts";
import { resolveKnowledgeTextPath } from "./knowledge-text-path";

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

export type PageChunkContextItem = {
  order: number;
  header: string | null;
  text: string;
  /** source page number (PDF), when known */
  sourcePage: number | null;
  /** true for the chunk addressed by `order` (the hit), false for neighbours */
  matched: boolean;
};

export type PageChunkContext = {
  pageId: string;
  title: string;
  /**
   * Wiki path of the page, root first, titles joined by " / " (the last
   * segment is the page itself). Empty string for a top-level page. Tells an
   * agent where the surrounding chunks live in the tree.
   */
  path: string;
  /** the ids of the path segments, root first (parallel to `path`) */
  pathIds: string[];
  /** total chunk count of the page (bounds for the agent; 0 = not embedded) */
  totalChunks: number;
  chunks: PageChunkContextItem[];
};

const DEFAULT_BEFORE = 2;
const DEFAULT_AFTER = 2;
const MAX_SPAN = 20; // per-side cap so a single call can't blow up the context

export const getPageChunkContext = async (
  pageId: string,
  context: Context,
  options: { order?: number; before?: number; after?: number } = {}
): Promise<PageChunkContext> => {
  // permission check + resolve the linked knowledge_entry (throws if invisible)
  const page = await getKnowledgeTextById(pageId, context);
  const pagePath = await resolveKnowledgeTextPath(page.id, context.tenantId);
  const base = {
    pageId: page.id,
    title: page.title,
    path: pagePath?.path ?? "",
    pathIds: pagePath?.pathIds ?? [],
  };

  if (!page.knowledgeEntryId) {
    // page without embeddings: no chunks exist
    return { ...base, totalChunks: 0, chunks: [] };
  }

  const before = Math.min(
    Math.max(options.before ?? DEFAULT_BEFORE, 0),
    MAX_SPAN
  );
  const after = Math.min(Math.max(options.after ?? DEFAULT_AFTER, 0), MAX_SPAN);
  const center = options.order ?? 0;

  const countRows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.knowledgeEntryId, page.knowledgeEntryId));
  const totalChunks = countRows[0]?.count ?? 0;

  const rows = await getDb()
    .select({
      order: knowledgeChunks.order,
      header: knowledgeChunks.header,
      text: knowledgeChunks.text,
      meta: knowledgeChunks.meta,
    })
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.knowledgeEntryId, page.knowledgeEntryId),
        gte(knowledgeChunks.order, center - before),
        lte(knowledgeChunks.order, center + after)
      )
    )
    .orderBy(asc(knowledgeChunks.order));

  return {
    ...base,
    totalChunks,
    chunks: rows.map((r) => ({
      order: r.order,
      header: r.header,
      text: r.text,
      sourcePage: r.meta?.page ?? null,
      matched: r.order === center,
    })),
  };
};
