/**
 * Hybrid search over knowledgeText wiki pages (B4 — search as the workhorse).
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
 *
 * B4 additions on top of the base fusion:
 *   - results carry summary (B1), facets (B3) and updatedAt alongside the
 *     snippet, so an agent can decide which 2-3 pages to read in one call;
 *   - facet + scope filters (pageType / status / subtree);
 *   - trust-aware ranking (verified boosted, outdated demoted) and grouping of
 *     superseded pages under their successor.
 */

import { sql, and, inArray, type SQL } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText, knowledgeChunks } from "../db/schema/knowledge";
import { buildKnowledgeTextVisibilityConditions } from "./knowledge-texts";
import { generateEmbedding } from "./embedding";
import type { FacetFilters } from "./facets";
import log from "../log";

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

export type KnowledgeTextSearchMode = "hybrid" | "fulltext" | "semantic";

/** Scope + facet filters narrowing a search. */
export interface SearchFilters extends FacetFilters {
  /** Restrict to a subtree (this page id and all its descendants). */
  parentId?: string;
}

export type KnowledgeTextSearchResult = {
  id: string;
  title: string;
  /** fused RRF score (higher = better), after trust weighting */
  score: number;
  /** short excerpt around the best match */
  snippet: string;
  /** which retrieval legs found this page */
  matchedBy: ("fulltext" | "semantic")[];
  /** B1 summary */
  summary: string | null;
  /** B3 facets */
  pageType: string | null;
  status: string | null;
  updatedAt: string;
  /** this page replaces the referenced page (B3) */
  supersedesId: string | null;
  /** superseded pages that also matched, folded under this (canonical) result */
  supersededAlternatives?: { id: string; title: string }[];
};

const RRF_K = 60;

/** Trust weight applied to the fused score based on the status facet. */
const statusWeight = (status: string | null): number => {
  if (status === "verifiziert") return 1.2;
  if (status === "veraltet") return 0.6;
  return 1;
};

type RankedHit = { id: string; title: string; snippet: string };

/** Combine extra (facet/scope) conditions into a single SQL fragment. */
const extraWhere = (conditions: SQL[]): SQL =>
  conditions.length > 0
    ? sql` AND ${sql.join(conditions, sql` AND `)}`
    : sql``;

/** Full-text leg: websearch query with ts_headline snippets */
const fulltextSearch = async (
  query: string,
  context: Context,
  limit: number,
  extra: SQL
): Promise<RankedHit[]> => {
  const visibility = and(...buildKnowledgeTextVisibilityConditions(context));
  // must match the expression of knowledge_text_fts_idx exactly (including
  // the base_safe_tsvector wrapper), otherwise the GIN index is not used
  const document = sql`base_safe_tsvector('simple', coalesce(${knowledgeText.title}, '') || ' ' || coalesce(${knowledgeText.text}, ''))`;
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
    WHERE ${visibility} AND ${document} @@ ${tsQuery}${extra}
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
      AND (${knowledgeText.title} ILIKE ${pattern} OR ${knowledgeText.text} ILIKE ${pattern})${extra}
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
  limit: number,
  extra: SQL
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
      WHERE ${visibility} AND ${embeddingColumn} IS NOT NULL${extra}
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
 * Descendant page ids (incl. root) for a subtree, restricted to visible pages.
 * Local copy to keep the search module free of cross-imports.
 */
const visibleSubtreeIds = async (
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
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const c of childrenByParent.get(id) ?? []) stack.push(c);
  }
  return out;
};

/**
 * Search wiki pages. `mode` (default "hybrid"):
 *   - "fulltext": lexical only, no embedding provider needed
 *   - "semantic": embeddings only (embedding-enabled pages)
 *   - "hybrid": both, fused with Reciprocal Rank Fusion
 *
 * Results are enriched with summary + facets + updatedAt, trust-weighted by
 * status, and superseded pages are folded under their successor.
 */
export const searchKnowledgeTexts = async (
  query: string,
  context: Context,
  options?: {
    mode?: KnowledgeTextSearchMode;
    limit?: number;
    filters?: SearchFilters;
  }
): Promise<KnowledgeTextSearchResult[]> => {
  const mode = options?.mode ?? "hybrid";
  const limit = options?.limit ?? 10;
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // Build extra (facet + scope) conditions shared by both legs.
  const extraConditions: SQL[] = [];
  const filters = options?.filters ?? {};
  if (filters.pageType) {
    extraConditions.push(sql`${knowledgeText.pageType} = ${filters.pageType}`);
  }
  if (filters.status) {
    extraConditions.push(sql`${knowledgeText.status} = ${filters.status}`);
  }
  if (filters.parentId) {
    const ids = await visibleSubtreeIds(filters.parentId, context);
    if (ids.length === 0) return [];
    extraConditions.push(
      sql`${knowledgeText.id} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )})`
    );
  }
  const extra = extraWhere(extraConditions);

  // fetch more per leg than requested so the fusion has material to rank
  const perLeg = Math.max(limit * 2, 20);

  const [fulltextHits, semanticHits] = await Promise.all([
    mode !== "semantic"
      ? fulltextSearch(trimmed, context, perLeg, extra)
      : Promise.resolve([]),
    mode !== "fulltext"
      ? semanticSearch(trimmed, context, perLeg, extra).catch((error) => {
          if (mode === "semantic") throw error;
          // hybrid degrades gracefully to fulltext when no provider is
          // configured or embedding generation fails
          log.debug(`Semantic search leg unavailable: ${error}`);
          return [] as RankedHit[];
        })
      : Promise.resolve([]),
  ]);

  // Reciprocal Rank Fusion
  type Fused = {
    id: string;
    title: string;
    score: number;
    snippet: string;
    matchedBy: ("fulltext" | "semantic")[];
  };
  const fused = new Map<string, Fused>();
  const addLeg = (hits: RankedHit[], leg: "fulltext" | "semantic") => {
    hits.forEach((hit, rank) => {
      const existing = fused.get(hit.id);
      const contribution = 1 / (RRF_K + rank + 1);
      if (existing) {
        existing.score += contribution;
        existing.matchedBy.push(leg);
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

  if (fused.size === 0) return [];

  // Enrich with summary + facets + updatedAt in one query.
  const fusedIds = [...fused.keys()];
  const meta = await getDb()
    .select({
      id: knowledgeText.id,
      summary: knowledgeText.summary,
      pageType: knowledgeText.pageType,
      status: knowledgeText.status,
      updatedAt: knowledgeText.updatedAt,
      supersedesId: knowledgeText.supersedesId,
    })
    .from(knowledgeText)
    .where(inArray(knowledgeText.id, fusedIds));
  const metaById = new Map(meta.map((m) => [m.id, m]));

  const enriched: KnowledgeTextSearchResult[] = [...fused.values()].map((f) => {
    const m = metaById.get(f.id);
    const status = m?.status ?? null;
    return {
      ...f,
      // trust-aware ranking: verified boosted, outdated demoted
      score: f.score * statusWeight(status),
      summary: m?.summary ?? null,
      pageType: m?.pageType ?? null,
      status,
      updatedAt: m?.updatedAt ?? "",
      supersedesId: m?.supersedesId ?? null,
    };
  });

  enriched.sort((a, b) => b.score - a.score);

  // Grouping / dedup: fold a superseded page under its successor when both
  // matched, so the 200-similar-pages case doesn't return 200 equal hits.
  const present = new Set(enriched.map((r) => r.id));
  const supersededBySuccessor = new Set<string>();
  const successorOf = new Map<string, { id: string; title: string }[]>();
  for (const r of enriched) {
    if (r.supersedesId && present.has(r.supersedesId)) {
      supersededBySuccessor.add(r.supersedesId);
      const alt = successorOf.get(r.id) ?? [];
      const superseded = enriched.find((x) => x.id === r.supersedesId);
      if (superseded)
        alt.push({ id: superseded.id, title: superseded.title });
      successorOf.set(r.id, alt);
    }
  }

  const grouped = enriched
    .filter((r) => !supersededBySuccessor.has(r.id))
    .map((r) => {
      const alts = successorOf.get(r.id);
      return alts && alts.length > 0
        ? { ...r, supersededAlternatives: alts }
        : r;
    });

  return grouped.slice(0, limit);
};
