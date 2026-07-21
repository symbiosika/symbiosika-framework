/**
 * Re-embedding after an embedding model/provider change.
 *
 * Vectors are only comparable within one model, so the searches filter stored
 * chunks by the currently configured model id (see embedding.ts). After a
 * model/provider switch, chunks embedded with the old model therefore become
 * invisible to the semantic legs until they are re-embedded — this module
 * closes that gap via the framework's durable job queue:
 *
 *   1. `findKnowledgeEntriesNeedingReEmbed` lists a tenant's knowledge entries
 *      that still have chunks of a different model than the configured one.
 *   2. `enqueueReEmbedding` creates one `knowledge:re-embed` job per such
 *      entry (deduped against already queued/running jobs), so a big knowledge
 *      base is worked off gradually by the queue instead of one giant task.
 *   3. The job handler re-embeds an entry's outdated chunks in place: same
 *      row, same text/order/meta — only model, dimensions and the vector
 *      columns change. Idempotent; chunks already on the configured model are
 *      never touched, so a re-run only processes what is still outdated.
 *
 * Everything no-ops gracefully when no embedding provider is configured.
 */

import { and, eq, ne, sql, inArray } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeChunks, knowledgeEntry } from "../db/schema/knowledge";
import { jobs } from "../db/schema/jobs";
import { createJob } from "../jobs";
import type { JobHandlerRegister } from "../jobs";
import {
  generateEmbedding,
  getConfiguredEmbeddingModelId,
} from "./embedding";
import log from "../log";

/** Job type for the durable per-entry re-embedding. */
export const RE_EMBED_JOB_TYPE = "knowledge:re-embed";

export type ReEmbedJobMetadata = {
  knowledgeEntryId: string;
  tenantId: string;
};

/**
 * Knowledge entries of a tenant that still have chunks embedded with a
 * different model than the currently configured one. Returns [] when no
 * embedding provider is configured.
 */
export const findKnowledgeEntriesNeedingReEmbed = async (
  tenantId: string
): Promise<{ knowledgeEntryId: string; outdatedChunks: number }[]> => {
  const model = getConfiguredEmbeddingModelId();
  if (!model) return [];

  const rows = await getDb()
    .select({
      knowledgeEntryId: knowledgeChunks.knowledgeEntryId,
      outdatedChunks: sql<number>`count(*)::int`,
    })
    .from(knowledgeChunks)
    .innerJoin(
      knowledgeEntry,
      eq(knowledgeChunks.knowledgeEntryId, knowledgeEntry.id)
    )
    .where(
      and(
        eq(knowledgeEntry.tenantId, tenantId),
        ne(knowledgeChunks.embeddingModel, model)
      )
    )
    .groupBy(knowledgeChunks.knowledgeEntryId);

  return rows;
};

/**
 * Re-embed one entry's outdated chunks in place with the configured model
 * (the job body). Idempotent — chunks already on the configured model are
 * skipped, so a retried job resumes where it stopped.
 */
export const reEmbedKnowledgeEntry = async (
  knowledgeEntryId: string,
  tenantId: string
): Promise<{ status: "re-embedded" | "skipped"; chunks: number }> => {
  const model = getConfiguredEmbeddingModelId();
  if (!model) {
    log.debug("Re-embed skipped: no embedding provider configured");
    return { status: "skipped", chunks: 0 };
  }

  const chunks = await getDb()
    .select({ id: knowledgeChunks.id, text: knowledgeChunks.text })
    .from(knowledgeChunks)
    .innerJoin(
      knowledgeEntry,
      eq(knowledgeChunks.knowledgeEntryId, knowledgeEntry.id)
    )
    .where(
      and(
        eq(knowledgeChunks.knowledgeEntryId, knowledgeEntryId),
        eq(knowledgeEntry.tenantId, tenantId),
        ne(knowledgeChunks.embeddingModel, model)
      )
    )
    .orderBy(knowledgeChunks.order);

  if (chunks.length === 0) return { status: "skipped", chunks: 0 };

  // Sequential on purpose: a background job should drain gently instead of
  // firing one embedding request per chunk at the provider simultaneously.
  for (const chunk of chunks) {
    const embedding = await generateEmbedding(chunk.text, { tenantId });
    await getDb()
      .update(knowledgeChunks)
      .set({
        embeddingModel: embedding.model,
        dimensions: embedding.dimensions,
        textEmbedding1536:
          embedding.dimensions === 1536 ? embedding.embedding : null,
        textEmbedding1024:
          embedding.dimensions === 1024 ? embedding.embedding : null,
      })
      .where(eq(knowledgeChunks.id, chunk.id));
  }

  log.debug(
    `Re-embedded ${chunks.length} chunk(s) of knowledge entry ${knowledgeEntryId} with model "${model}"`
  );
  return { status: "re-embedded", chunks: chunks.length };
};

/** Durable job registration for per-entry re-embedding. */
export const reEmbedJobRegister: JobHandlerRegister = {
  type: RE_EMBED_JOB_TYPE,
  handler: {
    execute: async (metadata: ReEmbedJobMetadata) => {
      return reEmbedKnowledgeEntry(metadata.knowledgeEntryId, metadata.tenantId);
    },
  },
};

/**
 * Enqueue one re-embed job per knowledge entry whose chunks are not on the
 * currently configured embedding model. Dedupes against entries that already
 * have a queued/running re-embed job, so the trigger can be called repeatedly
 * (e.g. from an admin route) without piling up duplicate work.
 */
export const enqueueReEmbedding = async (
  tenantId: string
): Promise<{ enqueued: number; outdatedEntries: number }> => {
  const candidates = await findKnowledgeEntriesNeedingReEmbed(tenantId);
  if (candidates.length === 0) return { enqueued: 0, outdatedEntries: 0 };

  const pending = await getDb()
    .select({ metadata: jobs.metadata })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, RE_EMBED_JOB_TYPE),
        inArray(jobs.status, ["pending", "running"])
      )
    );
  const alreadyQueued = new Set(
    pending
      .map(
        (j) => (j.metadata as { knowledgeEntryId?: string } | null)
          ?.knowledgeEntryId
      )
      .filter((id): id is string => typeof id === "string")
  );

  let enqueued = 0;
  for (const candidate of candidates) {
    if (alreadyQueued.has(candidate.knowledgeEntryId)) continue;
    await createJob(
      RE_EMBED_JOB_TYPE,
      {
        knowledgeEntryId: candidate.knowledgeEntryId,
        tenantId,
      } satisfies ReEmbedJobMetadata,
      tenantId
    );
    enqueued++;
  }

  if (enqueued > 0) {
    log.debug(`Re-embed: enqueued ${enqueued} knowledge entry job(s)`);
  }
  return { enqueued, outdatedEntries: candidates.length };
};
