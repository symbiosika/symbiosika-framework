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
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  knowledgeText,
  knowledgeTextBlock,
  knowledgeEntry,
  type KnowledgeTextSelect,
  type KnowledgeTextMeta,
} from "../db/schema/knowledge";
import { upsertKnowledgeFromText } from "./upsert-knowledge";
import { materializeBlocksTextWithSpans } from "./materialize-blocks";
import type { BlockSpan } from "./block-provenance";
import log from "../log";

/** Stable upsert key linking a wiki page to its knowledge entry */
export const knowledgeTextSourceIdentifier = (knowledgeTextId: string) =>
  `knowledge-text:${knowledgeTextId}`;

const contentHash = (title: string, text: string) =>
  createHash("sha256").update(`${title}\n${text}`).digest("hex");

/**
 * Character spans of a block-mode page's blocks within its materialized
 * `text`, used to tag chunks with their source block. Returns `undefined`
 * for text-mode pages, pages without blocks, or when the freshly materialized
 * text does not match the stored cache (so provenance is never mis-mapped).
 */
const resolveBlockSpans = async (
  page: KnowledgeTextSelect
): Promise<BlockSpan[] | undefined> => {
  if (page.contentMode !== "blocks") return undefined;

  const blocks = await getDb()
    .select({
      id: knowledgeTextBlock.id,
      type: knowledgeTextBlock.type,
      content: knowledgeTextBlock.content,
    })
    .from(knowledgeTextBlock)
    .where(eq(knowledgeTextBlock.knowledgeTextId, page.id))
    .orderBy(asc(knowledgeTextBlock.position));

  if (blocks.length === 0) return undefined;

  const { text, spans } = materializeBlocksTextWithSpans(blocks);
  if (spans.length === 0 || text !== page.text) return undefined;
  return spans;
};

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

  // Block provenance: for block-mode pages, map each chunk back to the block
  // it starts in so retrieval hits can deep-link to the exact spot. The spans
  // are only trustworthy when they describe the SAME text that gets chunked
  // (`page.text`); the materialized text is compared defensively, so a legacy
  // page whose cache drifted simply skips provenance instead of mis-mapping.
  const blockSpans = await resolveBlockSpans(page);

  const result = await upsertKnowledgeFromText({
    tenantId: page.tenantId,
    sourceIdentifier: knowledgeTextSourceIdentifier(page.id),
    title: page.title,
    text: page.text,
    sourceType: "text",
    sourceId: page.id,
    userId: page.userId ?? undefined,
    teamId: page.teamId ?? undefined,
    blockSpans,
  });

  await getDb()
    .update(knowledgeText)
    .set({
      knowledgeEntryId: result.id,
      meta: { ...meta, embeddingContentHash: hash },
    })
    .where(eq(knowledgeText.id, page.id));

  // Mirror the page's resolved public flag onto the RAG entry so public
  // similarity search (the retrieval path a public chatbot uses) can filter on
  // published content inside the vector query. Set here, where this sync owns
  // the mirror, so it covers both a freshly inserted and a replaced entry.
  await getDb()
    .update(knowledgeEntry)
    .set({ publicEffective: page.publicEffective })
    .where(eq(knowledgeEntry.id, result.id));

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
