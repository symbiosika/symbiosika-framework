/**
 * Backfill: embed wiki pages that are marked for embedding but have no RAG
 * mirror yet.
 *
 * Switching the organisation-wide embedding setting on marks every page in one
 * statement, but the vectors themselves cost a provider call per chunk — far
 * too slow and too expensive to do inside that request. This module works the
 * gap off through the framework's durable job queue instead:
 *
 *   1. `findKnowledgeTextsNeedingEmbedding` lists the tenant's pages that are
 *      marked, have content, and are not linked to a knowledge entry.
 *   2. `enqueueKnowledgeTextEmbeddingBackfill` creates one
 *      `knowledge:text-embedding` job per page (deduped against jobs that are
 *      already queued or running), so an admin can trigger it repeatedly
 *      without piling up duplicate work.
 *   3. The job handler runs the ordinary `syncKnowledgeTextEmbedding`, which is
 *      idempotent and re-checks the organisation setting — a page that no
 *      longer qualifies is simply skipped.
 *
 * The queue drains its due jobs sequentially, so a 300-page wiki trickles
 * through the embedding provider instead of hitting it all at once.
 */

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import { jobs } from "../db/schema/jobs";
import { createJob } from "../jobs";
import type { JobHandlerRegister } from "../jobs";
import { syncKnowledgeTextEmbedding } from "./knowledge-text-embedding";
import log from "../log";

/** Job type for the durable per-page embedding backfill. */
export const TEXT_EMBEDDING_JOB_TYPE = "knowledge:text-embedding";

export type TextEmbeddingJobMetadata = {
  knowledgeTextId: string;
  tenantId: string;
};

/** Pages that are marked for embedding, have content, but no mirror yet. */
const pendingPagesCondition = (tenantId: string) =>
  and(
    eq(knowledgeText.tenantId, tenantId),
    eq(knowledgeText.embeddingEnabled, true),
    isNull(knowledgeText.knowledgeEntryId),
    ne(sql`btrim(${knowledgeText.text})`, "")
  );

/** Ids of the pages still waiting for their first embedding. */
export const findKnowledgeTextsNeedingEmbedding = async (
  tenantId: string
): Promise<string[]> => {
  const rows = await getDb()
    .select({ id: knowledgeText.id })
    .from(knowledgeText)
    .where(pendingPagesCondition(tenantId))
    .orderBy(knowledgeText.updatedAt);
  return rows.map((row) => row.id);
};

/** How many pages are still waiting — for the settings UI. */
export const countKnowledgeTextsNeedingEmbedding = async (
  tenantId: string
): Promise<number> => {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(knowledgeText)
    .where(pendingPagesCondition(tenantId));
  return rows[0]?.count ?? 0;
};

/** Durable job registration for the per-page embedding backfill. */
export const textEmbeddingJobRegister: JobHandlerRegister = {
  type: TEXT_EMBEDDING_JOB_TYPE,
  handler: {
    execute: async (metadata: TextEmbeddingJobMetadata) =>
      syncKnowledgeTextEmbedding(metadata.knowledgeTextId, metadata.tenantId),
  },
};

export type EnqueueEmbeddingBackfillResult = {
  /** Jobs created by this call. */
  enqueued: number;
  /** Pages waiting for their first embedding when this call started. */
  pendingPages: number;
  /** Pages skipped because a job for them was already queued or running. */
  alreadyQueued: number;
};

/**
 * Enqueue one embedding job per page of this tenant that is marked for
 * embedding but not mirrored yet. Idempotent: pages with a queued or running
 * job are skipped, so an admin can press the button again after a partial run.
 */
export const enqueueKnowledgeTextEmbeddingBackfill = async (
  tenantId: string
): Promise<EnqueueEmbeddingBackfillResult> => {
  const pageIds = await findKnowledgeTextsNeedingEmbedding(tenantId);
  if (pageIds.length === 0) {
    return { enqueued: 0, pendingPages: 0, alreadyQueued: 0 };
  }

  const pending = await getDb()
    .select({ metadata: jobs.metadata })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, TEXT_EMBEDDING_JOB_TYPE),
        eq(jobs.tenantId, tenantId),
        inArray(jobs.status, ["pending", "running"])
      )
    );
  const queued = new Set(
    pending
      .map(
        (job) =>
          (job.metadata as { knowledgeTextId?: string } | null)?.knowledgeTextId
      )
      .filter((id): id is string => typeof id === "string")
  );

  let enqueued = 0;
  for (const knowledgeTextId of pageIds) {
    if (queued.has(knowledgeTextId)) continue;
    await createJob(
      TEXT_EMBEDDING_JOB_TYPE,
      { knowledgeTextId, tenantId } satisfies TextEmbeddingJobMetadata,
      tenantId
    );
    enqueued++;
  }

  log.debug(
    `Embedding backfill for tenant ${tenantId}: ${enqueued} job(s) enqueued ` +
      `of ${pageIds.length} pending page(s)`
  );

  return {
    enqueued,
    pendingPages: pageIds.length,
    alreadyQueued: pageIds.length - enqueued,
  };
};
