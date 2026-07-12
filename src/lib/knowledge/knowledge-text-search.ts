/**
 * Hybrid search over knowledgeText wiki pages.
 *
 * Combines two retrieval signals with Reciprocal Rank Fusion (RRF), the
 * standard recipe for hybrid lexical + semantic search:
 *
 *   1. Full-text search: Postgres tsvector over title + content with
 *      `websearch_to_tsquery` (supports quoted phrases, OR, -exclusion),
 *      backed by a GIN index. Uses the 'simple' config so mixed German/
 *      English wikis behave predictably. Falls back to substring matching
 *      when the FTS query yields nothing (partial words).
 *
 *   2. Semantic search: query embedding vs. the stored chunk embeddings of
 *      embedding-enabled pages (same pgvector index the RAG pipeline uses).
 *
 * The semantic leg needs an embedding provider; if it is unavailable or no
 * page has embeddings, the search degrades gracefully to full-text only.
 */

import { sql, and } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText, knowledgeChunks } from "../db/schema/knowledge";
import { buildKnowledgeTextVisibilityConditions } from "./knowledge-texts";
import { generateEmbedding } from "./embedding";
import log from "../log";

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

export type KnowledgeTextSearchMode = "hybrid" | "fulltext" | "semantic";

export type KnowledgeTextSearchResult = {
  id: string;
  title: string;
  /** fused RRF score (higher = better) */
  score: number;
  /** short excerpt around the best match */
  snippet: string;
  /** which retrieval legs found this page */
  matchedBy: ("fulltext" | "semantic")[];
};

const RRF_K = 60;

type RankedHit = { id: string; title: string; snippet: string };

/** Full-text leg: websearch query with ts_headline snippets */
const fulltextSearch = async (
  query: string,
  context: Context,
  limit: number
): Promise<RankedHit[]> => {
  const visibility = and(...buildKnowledgeTextVisibilityConditions(context));
  const document = sql`to_tsvector('simple', coalesce(${knowledgeText.title}, '') || ' ' || coalesce(${knowledgeText.text}, ''))`;
  const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;

  const rows = (await getDb().execute<RankedHit>(sql`
    SELECT
      ${knowledgeText.id} AS "id",
      ${knowledgeText.title} AS "title",
      ts_headline(
        'simple',
        ${knowledgeText.text},
        ${tsQuery},
        'MaxWords=40, MinWords=10, MaxFragments=1'
      ) AS "snippet"
    FROM ${knowledgeText}
    WHERE ${visibility} AND ${document} @@ ${tsQuery}
    ORDER BY ts_rank_cd(${document}, ${tsQuery}) DESC
    LIMIT ${limit};
  `)) as RankedHit[];

  if (rows.length > 0) return rows;

  // fallback for partial words the tokenizer can't match (e.g. "Urlaub"
  // inside "Urlaubsregelung"): case-insensitive substring search
  const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const fallbackRows = (await getDb().execute<
    RankedHit & { text: string }
  >(sql`
    SELECT
      ${knowledgeText.id} AS "id",
      ${knowledgeText.title} AS "title",
      ${knowledgeText.text} AS "text",
      '' AS "snippet"
    FROM ${knowledgeText}
    WHERE ${visibility}
      AND (${knowledgeText.title} ILIKE ${pattern} OR ${knowledgeText.text} ILIKE ${pattern})
    ORDER BY ${knowledgeText.title} ASC
    LIMIT ${limit};
  `)) as (RankedHit & { text: string })[];

  return fallbackRows.map((row) => {
    const index = row.text.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, index - 60);
    const snippet =
      index >= 0
        ? row.text.slice(start, index + query.length + 120).trim()
        : row.text.slice(0, 180).trim();
    return { id: row.id, title: row.title, snippet };
  });
};

/** Semantic leg: query embedding vs. stored chunk embeddings, best chunk per page */
const semanticSearch = async (
  query: string,
  context: Context,
  limit: number
): Promise<RankedHit[]> => {
  const embed = await generateEmbedding(query, {
    tenantId: context.tenantId,
    userId: context.userId,
  });
  const embeddingColumn =
    embed.dimensions === 1536
      ? knowledgeChunks.textEmbedding1536
      : knowledgeChunks.textEmbedding1024;
  const queryVector = sql.raw(`'[${embed.embedding}]'`);
  const visibility = and(...buildKnowledgeTextVisibilityConditions(context));

  const rows = (await getDb().execute<RankedHit>(sql`
    SELECT
      "id", "title", "snippet"
    FROM (
      SELECT DISTINCT ON (${knowledgeText.id})
        ${knowledgeText.id} AS "id",
        ${knowledgeText.title} AS "title",
        ${knowledgeChunks.text} AS "snippet",
        ${embeddingColumn} <-> ${queryVector} AS "distance"
      FROM ${knowledgeChunks}
      JOIN ${knowledgeText}
        ON ${knowledgeText.knowledgeEntryId} = ${knowledgeChunks.knowledgeEntryId}
      WHERE ${visibility} AND ${embeddingColumn} IS NOT NULL
      ORDER BY ${knowledgeText.id}, "distance" ASC
    ) AS best_chunk_per_page
    ORDER BY "distance" ASC
    LIMIT ${limit};
  `)) as RankedHit[];

  return rows.map((row) => ({
    ...row,
    snippet: row.snippet.length > 240 ? row.snippet.slice(0, 240) + "…" : row.snippet,
  }));
};

/**
 * Search wiki pages. `mode` (default "hybrid"):
 *   - "fulltext": lexical only, no embedding provider needed
 *   - "semantic": embeddings only (embedding-enabled pages)
 *   - "hybrid": both, fused with Reciprocal Rank Fusion
 */
export const searchKnowledgeTexts = async (
  query: string,
  context: Context,
  options?: { mode?: KnowledgeTextSearchMode; limit?: number }
): Promise<KnowledgeTextSearchResult[]> => {
  const mode = options?.mode ?? "hybrid";
  const limit = options?.limit ?? 10;
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // fetch more per leg than requested so the fusion has material to rank
  const perLeg = Math.max(limit * 2, 20);

  const [fulltextHits, semanticHits] = await Promise.all([
    mode !== "semantic"
      ? fulltextSearch(trimmed, context, perLeg)
      : Promise.resolve([]),
    mode !== "fulltext"
      ? semanticSearch(trimmed, context, perLeg).catch((error) => {
          if (mode === "semantic") throw error;
          // hybrid degrades gracefully to fulltext when no provider is
          // configured or embedding generation fails
          log.debug(`Semantic search leg unavailable: ${error}`);
          return [] as RankedHit[];
        })
      : Promise.resolve([]),
  ]);

  // Reciprocal Rank Fusion
  const fused = new Map<string, KnowledgeTextSearchResult>();
  const addLeg = (hits: RankedHit[], leg: "fulltext" | "semantic") => {
    hits.forEach((hit, rank) => {
      const existing = fused.get(hit.id);
      const contribution = 1 / (RRF_K + rank + 1);
      if (existing) {
        existing.score += contribution;
        existing.matchedBy.push(leg);
        // prefer the fulltext headline as the shown snippet
        if (leg === "fulltext" && hit.snippet) existing.snippet = hit.snippet;
      } else {
        fused.set(hit.id, {
          id: hit.id,
          title: hit.title,
          score: contribution,
          snippet: hit.snippet,
          matchedBy: [leg],
        });
      }
    });
  };
  addLeg(fulltextHits, "fulltext");
  addLeg(semanticHits, "semantic");

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};
