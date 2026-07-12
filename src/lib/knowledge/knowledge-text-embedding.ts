/**
 * Optional embedding sync for knowledgeText wiki pages.
 *
 * Pages with `embeddingEnabled = true` are mirrored into the RAG pipeline
 * (knowledge_entry + knowledge_chunks) so they show up in similarity search.
 * The sync goes through `upsertKnowledgeFromText` with the stable source
 * identifier `knowledge-text:<pageId>`, so re-syncs replace the chunks of
 * the same knowledge entry in place instead of piling up duplicates.
 *
 * A sha256 hash of the materialized content is stored in
 * `meta.embeddingContentHash` to skip re-embedding unchanged pages —
 * important because block editors autosave frequently.
 */

import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  knowledgeText,
  knowledgeEntry,
  type KnowledgeTextSelect,
  type KnowledgeTextMeta,
} from "../db/schema/knowledge";
import { upsertKnowledgeFromText } from "./upsert-knowledge";
import log from "../log";

/** Stable upsert key linking a wiki page to its knowledge entry */
export const knowledgeTextSourceIdentifier = (knowledgeTextId: string) =>
  `knowledge-text:${knowledgeTextId}`;

const contentHash = (title: string, text: string) =>
  createHash("sha256").update(`${title}\n${text}`).digest("hex");

export type KnowledgeTextEmbeddingSyncResult = {
  /** true if an embedding upsert was performed */
  synced: boolean;
  /** true if a previously linked knowledge entry was removed */
  removed: boolean;
  /** true if the sync was skipped because the content is unchanged */
  unchanged: boolean;
  knowledgeEntryId: string | null;
};

/**
 * Delete the knowledge entry linked to a page (if any) and clear the link.
 * Used when embedding gets disabled, the page text becomes empty, or the
 * page is deleted.
 */
export const removeKnowledgeTextEmbedding = async (
  page: Pick<KnowledgeTextSelect, "id" | "tenantId" | "knowledgeEntryId">
): Promise<boolean> => {
  if (!page.knowledgeEntryId) return false;

  // chunks are removed by the FK cascade on knowledge_chunks
  await getDb()
    .delete(knowledgeEntry)
    .where(
      and(
        eq(knowledgeEntry.id, page.knowledgeEntryId),
        eq(knowledgeEntry.tenantId, page.tenantId)
      )
    );
  // the FK on knowledge_text.knowledge_entry_id is ON DELETE SET NULL, but
  // clear the hash explicitly so a re-enable triggers a fresh sync
  const meta = (page as KnowledgeTextSelect).meta as KnowledgeTextMeta | null;
  await getDb()
    .update(knowledgeText)
    .set({
      knowledgeEntryId: null,
      meta: { ...(meta ?? {}), embeddingContentHash: undefined },
    })
    .where(eq(knowledgeText.id, page.id));
  return true;
};

/**
 * Bring the RAG mirror of a page in line with its current state.
 *
 * - embedding disabled or empty text → remove a stale entry if present
 * - content unchanged since last sync → no-op
 * - otherwise → upsert entry + chunks and store the new content hash
 *
 * Permissions must be checked by the caller — this operates directly on the
 * page row (it is invoked after permission-checked writes).
 */
export const syncKnowledgeTextEmbedding = async (
  knowledgeTextId: string,
  tenantId: string
): Promise<KnowledgeTextEmbeddingSyncResult> => {
  const pages = await getDb()
    .select()
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.id, knowledgeTextId),
        eq(knowledgeText.tenantId, tenantId)
      )
    );
  const page = pages[0];
  if (!page) {
    throw new Error("Knowledge text not found");
  }

  const meta = (page.meta ?? {}) as KnowledgeTextMeta;

  // Disabled or nothing to embed → make sure no stale entry lingers
  if (!page.embeddingEnabled || page.text.trim().length === 0) {
    const removed = await removeKnowledgeTextEmbedding(page);
    return {
      synced: false,
      removed,
      unchanged: false,
      knowledgeEntryId: null,
    };
  }

  const hash = contentHash(page.title, page.text);
  if (page.knowledgeEntryId && meta.embeddingContentHash === hash) {
    return {
      synced: false,
      removed: false,
      unchanged: true,
      knowledgeEntryId: page.knowledgeEntryId,
    };
  }

  const result = await upsertKnowledgeFromText({
    tenantId: page.tenantId,
    sourceIdentifier: knowledgeTextSourceIdentifier(page.id),
    title: page.title,
    text: page.text,
    sourceType: "text",
    sourceId: page.id,
    userId: page.userId ?? undefined,
    teamId: page.teamId ?? undefined,
  });

  await getDb()
    .update(knowledgeText)
    .set({
      knowledgeEntryId: result.id,
      meta: { ...meta, embeddingContentHash: hash },
    })
    .where(eq(knowledgeText.id, page.id));

  return {
    synced: true,
    removed: false,
    unchanged: false,
    knowledgeEntryId: result.id,
  };
};

/**
 * Fire-and-forget wrapper used after page saves: an embedding failure
 * (missing API key, provider down) must never fail the save itself.
 */
export const syncKnowledgeTextEmbeddingSafe = async (
  knowledgeTextId: string,
  tenantId: string
): Promise<KnowledgeTextEmbeddingSyncResult | null> => {
  try {
    return await syncKnowledgeTextEmbedding(knowledgeTextId, tenantId);
  } catch (error) {
    log.error(
      `Embedding sync failed for knowledge text ${knowledgeTextId}: ${error}`
    );
    return null;
  }
};
