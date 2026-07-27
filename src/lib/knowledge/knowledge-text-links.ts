/**
 * Obsidian-style [[…]] page links between knowledgeText pages.
 *
 * Pages link to each other with `[[Target Title]]` (or `[[Target Title|shown
 * text]]`) anywhere in their markdown/html content. On every content save the
 * links of the page are re-extracted and stored in knowledge_text_link:
 *
 *   - resolved links carry the target page's id
 *   - links to titles that don't exist yet are kept as "phantom links"
 *     (targetId = null) and resolve automatically once a page with that
 *     title is created or renamed to it — exactly like Obsidian
 *   - deleting a target page turns its incoming links back into phantom
 *     links (FK ON DELETE SET NULL)
 *
 * On top of the explicit link graph, `getRelatedKnowledgeTexts` suggests
 * semantically similar pages via the stored chunk embeddings (no query
 * embedding needed, so it works without an embedding provider at runtime).
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  knowledgeText,
  knowledgeTextLink,
  knowledgeChunks,
  type KnowledgeTextLinkSelect,
} from "../db/schema/knowledge";
import {
  getKnowledgeTextById,
  buildKnowledgeTextVisibilityConditions,
} from "./knowledge-texts";
import { getConfiguredEmbeddingModelId } from "./embedding";
// the marker syntax itself (and its html / escaped variants) lives in one
// module shared with the write path and the block materialization
import { PAGE_LINK_PATTERN } from "./wikilinks";

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

/** Extract the distinct page link targets from a page's content */
export const extractPageLinkTargets = (content: string): string[] => {
  const targets = new Set<string>();
  for (const match of content.matchAll(PAGE_LINK_PATTERN)) {
    const target = match[1]?.trim();
    if (target) targets.add(target);
  }
  return [...targets];
};

/** Case-insensitive title → page id lookup within a tenant */
const resolveTitles = async (
  tenantId: string,
  titles: string[]
): Promise<Map<string, string>> => {
  if (titles.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: knowledgeText.id, title: knowledgeText.title })
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.tenantId, tenantId),
        inArray(
          sql`lower(${knowledgeText.title})`,
          titles.map((t) => t.toLowerCase())
        )
      )
    );
  const byLowerTitle = new Map<string, string>();
  for (const row of rows) {
    // first match wins on duplicate titles
    if (!byLowerTitle.has(row.title.toLowerCase())) {
      byLowerTitle.set(row.title.toLowerCase(), row.id);
    }
  }
  const resolved = new Map<string, string>();
  for (const title of titles) {
    const id = byLowerTitle.get(title.toLowerCase());
    if (id) resolved.set(title, id);
  }
  return resolved;
};

/**
 * Re-extract and store the outgoing links of a page from its content.
 * Called after every content write (create, update, block sync, edit).
 */
export const syncKnowledgeTextLinks = async (page: {
  id: string;
  tenantId: string;
  text: string;
}): Promise<void> => {
  const targets = extractPageLinkTargets(page.text).filter(
    (t) => t.length <= 1000
  );
  const resolved = await resolveTitles(page.tenantId, targets);

  await getDb()
    .delete(knowledgeTextLink)
    .where(eq(knowledgeTextLink.sourceId, page.id));

  if (targets.length === 0) return;

  await getDb().insert(knowledgeTextLink).values(
    targets.map((targetTitle) => {
      const targetId = resolved.get(targetTitle) ?? null;
      return {
        tenantId: page.tenantId,
        sourceId: page.id,
        // self-links are kept as phantom links pointing nowhere
        targetId: targetId === page.id ? null : targetId,
        targetTitle,
      };
    })
  );
};

/**
 * Resolve phantom links that point at `title` to the given page.
 * Called when a page is created or renamed, so links written before the
 * target existed snap into place — Obsidian behaviour.
 */
export const resolvePhantomLinks = async (page: {
  id: string;
  tenantId: string;
  title: string;
}): Promise<number> => {
  if (!page.title) return 0;
  const updated = await getDb()
    .update(knowledgeTextLink)
    .set({ targetId: page.id })
    .where(
      and(
        eq(knowledgeTextLink.tenantId, page.tenantId),
        isNull(knowledgeTextLink.targetId),
        sql`lower(${knowledgeTextLink.targetTitle}) = ${page.title.toLowerCase()}`,
        // never resolve a page's link to itself
        sql`${knowledgeTextLink.sourceId} != ${page.id}`
      )
    )
    .returning({ id: knowledgeTextLink.id });
  return updated.length;
};

export type KnowledgeTextLinkView = {
  /** the link row itself */
  targetTitle: string;
  resolved: boolean;
  /** target/source page — null for phantom links or invisible pages */
  page: { id: string; title: string } | null;
};

/**
 * Outgoing links of a page. Resolved targets the caller may not see are
 * reported as unresolved rather than leaking their existence.
 */
export const getKnowledgeTextLinks = async (
  id: string,
  context: Context
): Promise<KnowledgeTextLinkView[]> => {
  await getKnowledgeTextById(id, context); // permission check

  const links: KnowledgeTextLinkSelect[] = await getDb()
    .select()
    .from(knowledgeTextLink)
    .where(eq(knowledgeTextLink.sourceId, id));

  const targetIds = links
    .map((l) => l.targetId)
    .filter((t): t is string => t !== null);
  const visibleTargets = new Map<string, string>();
  if (targetIds.length > 0) {
    const rows = await getDb()
      .select({ id: knowledgeText.id, title: knowledgeText.title })
      .from(knowledgeText)
      .where(
        and(
          ...buildKnowledgeTextVisibilityConditions(context),
          inArray(knowledgeText.id, targetIds)
        )
      );
    for (const row of rows) visibleTargets.set(row.id, row.title);
  }

  return links.map((link) => {
    const visibleTitle = link.targetId
      ? visibleTargets.get(link.targetId)
      : undefined;
    return {
      targetTitle: link.targetTitle,
      resolved: visibleTitle !== undefined,
      page:
        link.targetId && visibleTitle !== undefined
          ? { id: link.targetId, title: visibleTitle }
          : null,
    };
  });
};

export type KnowledgeTextBacklinkView = {
  page: { id: string; title: string };
  /** the link target as written in the linking page */
  targetTitle: string;
};

/**
 * Incoming links: every page (visible to the caller) that links here.
 */
export const getKnowledgeTextBacklinks = async (
  id: string,
  context: Context
): Promise<KnowledgeTextBacklinkView[]> => {
  await getKnowledgeTextById(id, context); // permission check

  const rows = await getDb()
    .select({
      sourceId: knowledgeText.id,
      sourceTitle: knowledgeText.title,
      targetTitle: knowledgeTextLink.targetTitle,
    })
    .from(knowledgeTextLink)
    .innerJoin(
      knowledgeText,
      eq(knowledgeTextLink.sourceId, knowledgeText.id)
    )
    .where(
      and(
        eq(knowledgeTextLink.targetId, id),
        ...buildKnowledgeTextVisibilityConditions(context)
      )
    );

  return rows.map((row) => ({
    page: { id: row.sourceId, title: row.sourceTitle },
    targetTitle: row.targetTitle,
  }));
};

export type RelatedKnowledgeText = {
  id: string;
  title: string;
  /** cosine-style distance of the closest chunk pair (smaller = closer) */
  distance: number;
};

/**
 * Semantically related pages, computed from the stored chunk embeddings of
 * embedding-enabled pages (nearest chunks to this page's chunk centroid).
 * Returns [] when this page (or no other page) has embeddings.
 */
export const getRelatedKnowledgeTexts = async (
  id: string,
  context: Context,
  options?: { limit?: number }
): Promise<RelatedKnowledgeText[]> => {
  const page = await getKnowledgeTextById(id, context);
  if (!page.knowledgeEntryId) return [];
  const limit = options?.limit ?? 5;

  // load this page's chunk vectors and compute their centroid in JS
  const ownChunks = await getDb()
    .select({
      dimensions: knowledgeChunks.dimensions,
      embeddingModel: knowledgeChunks.embeddingModel,
      textEmbedding1536: knowledgeChunks.textEmbedding1536,
      textEmbedding1024: knowledgeChunks.textEmbedding1024,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.knowledgeEntryId, page.knowledgeEntryId));

  // Vectors are only comparable within one model. Prefer the currently
  // configured model; fall back to this page's stored model (page not yet
  // re-embedded), so centroid and candidates always share one vector space.
  const configuredModel = getConfiguredEmbeddingModelId();
  const model =
    configuredModel &&
    ownChunks.some((c) => c.embeddingModel === configuredModel)
      ? configuredModel
      : ownChunks[0]?.embeddingModel;
  if (!model) return [];

  const vectors = ownChunks
    .filter((c) => c.embeddingModel === model)
    .map((c) =>
      c.dimensions === 1536 ? c.textEmbedding1536 : c.textEmbedding1024
    )
    .filter((v): v is number[] => Array.isArray(v) && v.length > 0);
  if (vectors.length === 0) return [];

  const dimensions = vectors[0]!.length;
  const centroid = new Array(dimensions).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dimensions; i++) centroid[i] += vector[i]!;
  }
  for (let i = 0; i < dimensions; i++) centroid[i] /= vectors.length;

  const embeddingColumn =
    dimensions === 1536
      ? knowledgeChunks.textEmbedding1536
      : knowledgeChunks.textEmbedding1024;

  const visibility = and(...buildKnowledgeTextVisibilityConditions(context));
  const rows = await getDb().execute<RelatedKnowledgeText>(sql`
    SELECT
      ${knowledgeText.id} AS "id",
      ${knowledgeText.title} AS "title",
      MIN(${embeddingColumn} <=> ${sql.raw(`'[${centroid.join(",")}]'`)}) AS "distance"
    FROM ${knowledgeChunks}
    JOIN ${knowledgeText}
      ON ${knowledgeText.knowledgeEntryId} = ${knowledgeChunks.knowledgeEntryId}
    WHERE ${visibility}
      AND ${knowledgeChunks.knowledgeEntryId} != ${page.knowledgeEntryId}
      AND ${embeddingColumn} IS NOT NULL
      AND ${knowledgeChunks.embeddingModel} = ${model}
    GROUP BY ${knowledgeText.id}, ${knowledgeText.title}
    ORDER BY "distance" ASC
    LIMIT ${limit};
  `);

  return (rows as RelatedKnowledgeText[]).map((row) => ({
    ...row,
    distance: Number(row.distance),
  }));
};
