import { sql } from "drizzle-orm";
import { knowledgeChunks, knowledgeEntry } from "../db/db-schema";
import { getDb } from "../db/db-connection";
import log from "../log";
import { getFullSourceDocumentsForKnowledgeEntry } from "./get-knowledge";
import { and, eq, inArray } from "drizzle-orm";
import { knowledgeText, type KnowledgeChunkMeta } from "../db/schema/knowledge";
import { generateEmbedding } from "./embedding";
import { resolveKnowledgeTextPaths } from "./knowledge-text-path";

type ChunkWithPath<T extends { knowledgeEntryId: string }> = T & {
  knowledgeTextId: string | null;
  path: string | null;
  pathIds: string[];
};

/**
 * Attach the source wiki path to each chunk. A chunk's entry is a wiki page
 * when a knowledgeText row links back to it via knowledgeEntryId; that page's
 * breadcrumb becomes the chunk's path. Plain RAG documents (no linked page)
 * get null. Resolved in two batched queries regardless of the chunk count.
 */
const attachWikiPaths = async <T extends { knowledgeEntryId: string }>(
  chunks: T[],
  tenantId: string
): Promise<ChunkWithPath<T>[]> => {
  const entryIds = [...new Set(chunks.map((c) => c.knowledgeEntryId))];
  if (entryIds.length === 0) {
    return chunks.map((c) => ({
      ...c,
      knowledgeTextId: null,
      path: null,
      pathIds: [],
    }));
  }

  // entry -> wiki page (only mirrored pages link back via knowledgeEntryId)
  const pages = await getDb()
    .select({
      id: knowledgeText.id,
      knowledgeEntryId: knowledgeText.knowledgeEntryId,
    })
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.tenantId, tenantId),
        inArray(knowledgeText.knowledgeEntryId, entryIds)
      )
    );
  const pageIdByEntryId = new Map<string, string>();
  for (const p of pages) {
    if (p.knowledgeEntryId) pageIdByEntryId.set(p.knowledgeEntryId, p.id);
  }

  const pathByPageId = await resolveKnowledgeTextPaths(
    [...pageIdByEntryId.values()],
    tenantId
  );

  return chunks.map((c) => {
    const pageId = pageIdByEntryId.get(c.knowledgeEntryId) ?? null;
    const p = pageId ? pathByPageId.get(pageId) : undefined;
    return {
      ...c,
      knowledgeTextId: pageId,
      path: p?.path ?? null,
      pathIds: p?.pathIds ?? [],
    };
  });
};

type KnowledgeChunk = {
  id: string;
  text: string;
  knowledgeEntryId: string;
  knowledgeEntryName: string;
  order: number;
  meta: KnowledgeChunkMeta;
};

/** RRF constant, same value as the hybrid page search (knowledge-text-search.ts). */
const RRF_K = 60;

/**
 * Hybrid chunk retrieval: the n best chunks for the search text.
 *
 * Two legs, fused with Reciprocal Rank Fusion (the same recipe as the
 * knowledgeText page search):
 *   1. Semantic: query embedding vs. stored chunk embeddings (HNSW, cosine).
 *   2. Full-text: websearch_to_tsquery over header + chunk text, backed by
 *      the GIN index knowledge_chunks_fts_idx.
 *
 * The semantic leg needs the embedding provider; when it is unavailable the
 * search degrades gracefully to full-text only instead of throwing.
 */
export async function getNearestEmbeddings(q: {
  tenantId: string;
  searchText: string;
  n?: number;
  addBeforeN?: number;
  addAfterN?: number;
  filterKnowledgeEntryIds?: string[];
  filterKnowledgeGroupIds?: string[];
  filterName?: string[];
  workspaceId?: string;
}): Promise<
  {
    id: string;
    text: string;
    knowledgeEntryId: string;
    knowledgeEntryName: string;
    meta: KnowledgeChunkMeta;
    order: number;
    /**
     * id of the wiki page this chunk originates from, or null when the entry
     * is a plain RAG document (not mirrored from a wiki page).
     */
    knowledgeTextId: string | null;
    /**
     * Wiki path of the source page, root first, titles joined by " / " (the
     * last segment is the page itself) — so a consumer can see WHERE the chunk
     * comes from. null when the entry is not a wiki page.
     */
    path: string | null;
    /** the ids of the path segments, root first (parallel to `path`) */
    pathIds: string[];
  }[]
> {
  // set some default values
  if (!q.n) {
    q.n = 5;
  }
  if (!q.addBeforeN) {
    q.addBeforeN = 0;
  }
  if (!q.addAfterN) {
    q.addAfterN = 0;
  }

  const filters = [];
  if (q.filterKnowledgeEntryIds && q.filterKnowledgeEntryIds.length > 0) {
    filters.push(inArray(knowledgeEntry.id, q.filterKnowledgeEntryIds));
  }

  if (q.filterKnowledgeGroupIds && q.filterKnowledgeGroupIds.length > 0) {
    filters.push(
      inArray(knowledgeEntry.knowledgeGroupId, q.filterKnowledgeGroupIds)
    );
  }

  if (q.filterName && q.filterName.length > 0) {
    filters.push(sql`${knowledgeEntry.name} IN (${sql.join(q.filterName)})`);
  }

  const whereClause =
    filters.length > 0
      ? sql`WHERE ${sql.join(filters, sql` AND `)} AND ${knowledgeEntry.tenantId} = ${q.tenantId}`
      : sql`WHERE ${knowledgeEntry.tenantId} = ${q.tenantId}`;

  const selectColumns = sql`
      ${knowledgeChunks.id},
      ${knowledgeChunks.text},
      ${knowledgeChunks.knowledgeEntryId} AS "knowledgeEntryId",
      ${knowledgeEntry.name} AS "knowledgeEntryName",
      ${knowledgeChunks.order},
      ${knowledgeChunks.meta}`;

  // fetch more per leg than requested so the fusion has material to rank
  const perLeg = Math.max(q.n * 2, 20);

  // Semantic leg: query embedding vs. stored chunk embeddings (HNSW, cosine).
  // Restricted to chunks of the same model as the query embedding — vectors
  // of different models share no vector space, comparing them is meaningless.
  const semanticLeg = async (): Promise<KnowledgeChunk[]> => {
    const embed = await generateEmbedding(q.searchText, {
      tenantId: q.tenantId,
    });
    return (await getDb().execute<KnowledgeChunk>(sql`
      SELECT ${selectColumns}
      FROM
        ${knowledgeChunks}
      JOIN
        ${knowledgeEntry} ON ${knowledgeChunks.knowledgeEntryId} = ${knowledgeEntry.id}
      ${whereClause}
        AND ${knowledgeChunks.embeddingModel} = ${embed.model}
      ORDER BY
        ${
          embed.dimensions === 1536
            ? knowledgeChunks.textEmbedding1536
            : knowledgeChunks.textEmbedding1024
        } <=> ${sql.raw(`'[${embed.embedding}]'`)} ASC
      LIMIT
        ${perLeg};
    `)) as KnowledgeChunk[];
  };

  // Full-text leg. The document expression must match the one of
  // knowledge_chunks_fts_idx exactly, otherwise the GIN index is not used.
  const fulltextLeg = async (): Promise<KnowledgeChunk[]> => {
    const document = sql`base_safe_tsvector('simple', coalesce(${knowledgeChunks.header}, '') || ' ' || coalesce(${knowledgeChunks.text}, ''))`;
    const tsQuery = sql`websearch_to_tsquery('simple', ${q.searchText})`;
    return (await getDb().execute<KnowledgeChunk>(sql`
      SELECT ${selectColumns}
      FROM
        ${knowledgeChunks}
      JOIN
        ${knowledgeEntry} ON ${knowledgeChunks.knowledgeEntryId} = ${knowledgeEntry.id}
      ${whereClause}
        AND ${document} @@ ${tsQuery}
      ORDER BY
        ts_rank_cd(${document}, ${tsQuery}) DESC
      LIMIT
        ${perLeg};
    `)) as KnowledgeChunk[];
  };

  const [semanticHits, fulltextHits] = await Promise.all([
    // the semantic leg degrades gracefully when the embedding provider is
    // unavailable — the search then runs full-text only instead of failing
    semanticLeg().catch((error) => {
      log.error(`Semantic search leg unavailable: ${error}`);
      return [] as KnowledgeChunk[];
    }),
    fulltextLeg(),
  ]);

  // Reciprocal Rank Fusion over both legs, keyed by chunk id.
  const fused = new Map<string, { chunk: KnowledgeChunk; score: number }>();
  const addLeg = (hits: KnowledgeChunk[]) => {
    hits.forEach((chunk, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      const existing = fused.get(chunk.id);
      if (existing) {
        existing.score += contribution;
      } else {
        fused.set(chunk.id, { chunk, score: contribution });
      }
    });
  };
  addLeg(semanticHits);
  addLeg(fulltextHits);

  const rows = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, q.n)
    .map((f) => f.chunk);
  log.debug(
    `Found ${rows.length} chunks by hybrid search (semantic: ${semanticHits.length}, fulltext: ${fulltextHits.length})`
  );
  // log the knowledgeEntry.name of the chunks
  for (const chunk of rows) {
    log.debug(
      `Chunk: ${chunk.knowledgeEntryName} - ${chunk.text.slice(0, 20)} - ${chunk.knowledgeEntryId}`
    );
  }

  // return if no addBeforeN and addAfterN
  if (q.addBeforeN < 1 && q.addAfterN < 1) {
    return attachWikiPaths(rows, q.tenantId);
  }

  // Else. Also add before and after N
  // This will get the knowledgeEntryId and order.
  // Now it will try to add before and after N to the result by order.
  const usedKnowledgeEntryIds = new Set<string>();
  const resultRows: KnowledgeChunk[] = [];

  for (const e of rows) {
    if (usedKnowledgeEntryIds.has(e.knowledgeEntryId)) continue;
    usedKnowledgeEntryIds.add(e.knowledgeEntryId);
    log.debug(
      `Adding before and after chunks for entry: ${JSON.stringify({ ...e, text: "" })}`
    );

    // Get all entries with this knowledgeEntryId +- addBeforeN and addAfterN by SQL
    const entries = (await getDb().execute<KnowledgeChunk>(sql`
        SELECT
            ${knowledgeChunks.id}, 
            ${knowledgeChunks.text},
            ${knowledgeChunks.knowledgeEntryId} AS "knowledgeEntryId",
            ${knowledgeEntry.name} AS "knowledgeEntryName",
            ${knowledgeChunks.order}
        FROM 
            ${knowledgeChunks}
        JOIN 
            ${knowledgeEntry} ON ${knowledgeChunks.knowledgeEntryId} = ${knowledgeEntry.id}
        WHERE 
            ${knowledgeChunks.knowledgeEntryId} = ${e.knowledgeEntryId}
            AND ${knowledgeEntry.tenantId} = ${q.tenantId}
            AND ${knowledgeChunks.order} >= ${e.order - q.addBeforeN}
            AND ${knowledgeChunks.order} <= ${e.order + q.addAfterN}
        `)) as KnowledgeChunk[];

    log.debug(
      `Found ${entries.length} additional chunks for knowledgeEntryId: ${e.knowledgeEntryId}`
    );
    resultRows.push(...entries);
  }
  return attachWikiPaths(resultRows, q.tenantId);
}

/**
 * Get full source documents to a simalialarity search
 * This will search for the nearest chunks and then get the full source documents
 */
export async function getFullSourceDocumentsForSimilaritySearch(q: {
  tenantId: string;
  searchText: string;
  n?: number;
  filterKnowledgeEntryIds?: string[];
  filterKnowledgeGroupIds?: string[];
  filterName?: string[];
  userId: string;
}) {
  // search for the nearest chunks
  const nearestChunks = await getNearestEmbeddings(q);

  // get the full source documents
  const fullSourceDocuments = await Promise.all(
    nearestChunks.map((chunk) =>
      getFullSourceDocumentsForKnowledgeEntry(
        chunk.knowledgeEntryId,
        q.tenantId,
        q.userId
      )
    )
  );

  return fullSourceDocuments;
}
