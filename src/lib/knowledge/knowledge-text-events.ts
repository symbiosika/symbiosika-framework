/**
 * Single choke-point for emitting knowledge_text (wiki page) lifecycle webhook
 * events. Every code path that creates / updates / deletes a knowledge_text row
 * in a way that "effectively changes a document" calls one of the emit helpers
 * here — so the payload shape, the event names and the tenant/source handling
 * live in exactly one place.
 *
 * Deliberately NOT wrapped around the raw DB writes: the create/update/delete
 * functions run a chunk/vector pipeline (bookkeeping + embedding sync) after
 * the row write, and the block editor writes inside a transaction. Emitting
 * from the semantic functions AFTER that work has completed (and, for the block
 * editor, after the transaction has committed) keeps the pipeline untouched and
 * guarantees we never fire an event for a write that was later rolled back.
 *
 * IMPORTANT: the payload never contains the page `text` (wiki pages can be
 * large). Receivers get the id + metadata and fetch the content via the API if
 * they need it.
 *
 * Pure derived-state writes (AI summary regeneration, embedding-link bookkeeping)
 * do NOT call these helpers and therefore never emit — they are not a change to
 * the document a user authored.
 */
import { dispatchEvent, type WebhookEventSource } from "../webhooks/dispatch";
import type { KnowledgeTextSelect } from "../db/schema/knowledge";
import log from "../log";

/** The subset of a knowledge_text row delivered in the webhook payload. */
export interface KnowledgeTextEventData {
  id: string;
  title: string;
  parentId: string | null;
  tenantWide: boolean;
  teamId: string | null;
  userId: string | null;
  contentMode: string;
  pageType: string | null;
  status: string | null;
  hidden: boolean;
  isAgentInstructions: boolean;
  embeddingEnabled: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Build the metadata payload for a page — intentionally excludes `text`. */
const toEventData = (page: KnowledgeTextSelect): KnowledgeTextEventData => ({
  id: page.id,
  title: page.title,
  parentId: page.parentId,
  tenantWide: page.tenantWide,
  teamId: page.teamId,
  userId: page.userId,
  contentMode: page.contentMode,
  pageType: page.pageType,
  status: page.status,
  hidden: page.hidden,
  isAgentInstructions: page.isAgentInstructions,
  embeddingEnabled: page.embeddingEnabled,
  createdBy: page.createdBy,
  updatedBy: page.updatedBy,
  createdAt: page.createdAt,
  updatedAt: page.updatedAt,
});

/**
 * A page was created. `source` distinguishes a direct user/API create from a
 * sync-driven one (e.g. upsertKnowledgeTextFromSource).
 */
export const emitKnowledgeTextCreated = async (
  page: KnowledgeTextSelect,
  source: WebhookEventSource = "user"
): Promise<void> => {
  try {
    await dispatchEvent(page.tenantId, "knowledge_text.created", toEventData(page), {
      source,
      userId: page.userId ?? undefined,
    });
  } catch (e) {
    log.error(
      `emitKnowledgeTextCreated failed for ${page.id}: ${(e as Error).message}`
    );
  }
};

/** A page's content or metadata effectively changed. */
export const emitKnowledgeTextUpdated = async (
  page: KnowledgeTextSelect,
  source: WebhookEventSource = "user"
): Promise<void> => {
  try {
    await dispatchEvent(page.tenantId, "knowledge_text.updated", toEventData(page), {
      source,
      userId: page.userId ?? undefined,
    });
  } catch (e) {
    log.error(
      `emitKnowledgeTextUpdated failed for ${page.id}: ${(e as Error).message}`
    );
  }
};

/**
 * A page was deleted. The row is already gone, so the payload carries only the
 * id (plus the tenant it belonged to, via the dispatch scope).
 */
export const emitKnowledgeTextDeleted = async (
  page: Pick<KnowledgeTextSelect, "id" | "tenantId" | "userId">,
  source: WebhookEventSource = "user"
): Promise<void> => {
  try {
    await dispatchEvent(
      page.tenantId,
      "knowledge_text.deleted",
      { id: page.id },
      { source, userId: page.userId ?? undefined }
    );
  } catch (e) {
    log.error(
      `emitKnowledgeTextDeleted failed for ${page.id}: ${(e as Error).message}`
    );
  }
};
