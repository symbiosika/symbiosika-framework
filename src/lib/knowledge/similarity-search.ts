import { sql } from "drizzle-orm";
import { knowledgeChunks, knowledgeEntry } from "../db/db-schema";
import { getDb } from "../db/db-connection";
import log from "../log";
import { getFullSourceDocumentsForKnowledgeEntry } from "./get-knowledge";
import { and, eq, inArray } from "drizzle-orm";
import {
  type KnowledgeChunkMeta,
  knowledgeFilters,
} from "../db/schema/knowledge";
import { generateEmbedding } from "./embedding";

type KnowledgeChunk = {
  id: string;
  text: string;
  knowledgeEntryId: string;
  knowledgeEntryName: string;
  order: number;
  meta: KnowledgeChunkMeta;
};

/**
 * Get the n nearest embeddings to the search text
 */
export async function getNearestEmbeddings(q: {
  organisationId: string;
  searchText: string;
  n?: number;
  addBeforeN?: number;
  addAfterN?: number;
  filterKnowledgeEntryIds?: string[];
  filterKnowledgeGroupIds?: string[];
  filterKnowledgeFilterIds?: string[];
  filter?: Record<string, string[]>;
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
  }[]
> {
  // Generate the embedding for the search text
  const embed = await generateEmbedding(q.searchText, {
    organisationId: q.organisationId,
  });

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
      ? sql`WHERE ${sql.join(filters, sql` AND `)} AND ${knowledgeEntry.organisationId} = ${q.organisationId}`
      : sql`WHERE ${knowledgeEntry.organisationId} = ${q.organisationId}`;

  const rows = (await getDb().execute<KnowledgeChunk>(sql`
    SELECT
      ${knowledgeChunks.id},
      ${knowledgeChunks.text},
      ${knowledgeChunks.knowledgeEntryId} AS "knowledgeEntryId",
      ${knowledgeEntry.name} AS "knowledgeEntryName",
      ${knowledgeChunks.order},
      ${knowledgeChunks.meta}
    FROM 
      ${knowledgeChunks}
    JOIN 
      ${knowledgeEntry} ON ${knowledgeChunks.knowledgeEntryId} = ${knowledgeEntry.id}
    ${whereClause}
    ORDER BY
      ${knowledgeChunks.textEmbedding} <-> ${sql.raw(`'[${embed.embedding}]'`)} ASC
    LIMIT
      ${q.n};
  `)) as KnowledgeChunk[];
  log.debug(`Found ${rows.length} chunks by similarity search`);
  // log the knowledgeEntry.name of the chunks
  for (const chunk of rows) {
    log.debug(
      `Chunk: ${chunk.knowledgeEntryName} - ${chunk.text.slice(0, 20)} - ${chunk.knowledgeEntryId}`
    );
  }

  // return if no addBeforeN and addAfterN
  if (q.addBeforeN < 1 && q.addAfterN < 1) {
    return rows;
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
            AND ${knowledgeEntry.organisationId} = ${q.organisationId}
            AND ${knowledgeChunks.order} >= ${e.order - q.addBeforeN}
            AND ${knowledgeChunks.order} <= ${e.order + q.addAfterN}
        `)) as KnowledgeChunk[];

    log.debug(
      `Found ${entries.length} additional chunks for knowledgeEntryId: ${e.knowledgeEntryId}`
    );
    resultRows.push(...entries);
  }
  return resultRows;
}

/**
 * Get full source documents to a simalialarity search
 * This will search for the nearest chunks and then get the full source documents
 */
export async function getFullSourceDocumentsForSimilaritySearch(q: {
  organisationId: string;
  searchText: string;
  n?: number;
  filterKnowledgeEntryIds?: string[];
  filterKnowledgeGroupIds?: string[];
  filter?: Record<string, string[]>;
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
        q.organisationId,
        q.userId
      )
    )
  );

  return fullSourceDocuments;
}
