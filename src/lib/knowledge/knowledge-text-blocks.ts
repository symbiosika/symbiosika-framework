/**
 * Block-based content for knowledgeText wiki pages (Notion-style).
 *
 * A page in `contentMode = "blocks"` stores its content as ordered
 * knowledge_text_block rows (markdown or html for now). The page's `text`
 * column is kept as a materialized cache assembled from the blocks on every
 * save, so full-text consumers (search, export, embedding) keep reading a
 * single column.
 *
 * Saving goes through `syncKnowledgeTextBlocks`: the client (block editor)
 * sends the full desired block list, the server diffs against the stored
 * blocks by id (insert / update / delete), reuses fractional-index positions
 * where the order is unchanged, snapshots history (coalesced, since block
 * editors autosave), and optionally re-syncs the page's embedding mirror.
 */

import { asc, eq, and, desc, inArray, sql } from "drizzle-orm";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { getDb } from "../db/db-connection";
import {
  knowledgeText,
  knowledgeTextBlock,
  knowledgeTextHistory,
  type KnowledgeTextBlockSelect,
  type KnowledgeTextBlockSnapshot,
  type KnowledgeTextHistoryInsert,
  type KnowledgeTextSelect,
} from "../db/schema/knowledge";
import { assignPositions } from "../utils/fractional-index";
import {
  getKnowledgeTextById,
  checkKnowledgeTextWritePermission,
  stripNullBytes,
  runBookkeepingSafe,
} from "./knowledge-texts";
import { syncKnowledgeTextEmbeddingSafe } from "./knowledge-text-embedding";
import { syncKnowledgeTextLinks } from "./knowledge-text-links";
import { syncKnowledgeTextFileReferences } from "./knowledge-text-files";

/** Minimum age of the newest history entry before a new snapshot is written */
export const HISTORY_COALESCE_MINUTES = 10;

export type KnowledgeTextBlockInput = {
  /** existing block id; omit for new blocks */
  id?: string;
  type: "markdown" | "html";
  content: string;
  meta?: Record<string, unknown>;
};

export type SyncKnowledgeTextBlocksOptions = {
  /** skip the embedding re-sync after saving (default: run it) */
  skipEmbeddingSync?: boolean;
  /** override the history coalescing window, in minutes; 0 = always snapshot */
  historyCoalesceMinutes?: number;
};

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

let turndown: TurndownService | null = null;
const getTurndown = (): TurndownService => {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    turndown.use(gfm);
  }
  return turndown;
};

/**
 * Assemble the page's materialized `text` from its blocks. HTML blocks are
 * converted to markdown so the cache stays homogeneous for search/embedding.
 */
export const materializeBlocksText = (
  blocks: Pick<KnowledgeTextBlockInput, "type" | "content">[]
): string => {
  return blocks
    .map((block) =>
      block.type === "html"
        ? getTurndown().turndown(block.content).trim()
        : block.content.trim()
    )
    .filter((part) => part.length > 0)
    .join("\n\n");
};

const toSnapshot = (
  block: KnowledgeTextBlockSelect
): KnowledgeTextBlockSnapshot => ({
  id: block.id,
  type: block.type,
  content: block.content,
  position: block.position,
  meta: (block.meta ?? {}) as Record<string, unknown>,
});

/**
 * Get all blocks of a page in display order.
 * Returns an empty list for pages still in `contentMode = "text"`.
 */
export const getKnowledgeTextBlocks = async (
  knowledgeTextId: string,
  context: Context
): Promise<KnowledgeTextBlockSelect[]> => {
  // permission check (throws if not visible to this user)
  await getKnowledgeTextById(knowledgeTextId, context);

  return await getDb()
    .select()
    .from(knowledgeTextBlock)
    .where(eq(knowledgeTextBlock.knowledgeTextId, knowledgeTextId))
    .orderBy(asc(knowledgeTextBlock.position));
};

/**
 * Write a coalesced history snapshot of the page's CURRENT state (before the
 * pending update), including its current blocks. Skipped when the newest
 * history entry is younger than the coalescing window, so autosaving editors
 * don't flood the history table.
 */
const snapshotHistoryCoalesced = async (
  page: KnowledgeTextSelect,
  currentBlocks: KnowledgeTextBlockSelect[],
  coalesceMinutes: number
) => {
  if (coalesceMinutes > 0) {
    const newest = await getDb()
      .select({ createdAt: knowledgeTextHistory.createdAt })
      .from(knowledgeTextHistory)
      .where(eq(knowledgeTextHistory.knowledgeTextId, page.id))
      .orderBy(desc(knowledgeTextHistory.createdAt))
      .limit(1);

    if (newest[0]) {
      const ageMs = Date.now() - new Date(newest[0].createdAt).getTime();
      if (ageMs < coalesceMinutes * 60 * 1000) {
        return false;
      }
    }
  }

  const historyEntry: KnowledgeTextHistoryInsert = {
    knowledgeTextId: page.id,
    tenantId: page.tenantId,
    tenantWide: page.tenantWide,
    teamId: page.teamId,
    userId: page.userId,
    parentId: page.parentId,
    text: page.text,
    title: page.title,
    meta: page.meta,
    hidden: page.hidden,
    contentMode: page.contentMode,
    blocks:
      page.contentMode === "blocks" ? currentBlocks.map(toSnapshot) : null,
  };
  await getDb().insert(knowledgeTextHistory).values(historyEntry);
  return true;
};

export type SyncKnowledgeTextBlocksResult = {
  knowledgeText: KnowledgeTextSelect;
  blocks: KnowledgeTextBlockSelect[];
  /** counts of what the diff actually changed */
  changes: { inserted: number; updated: number; deleted: number };
  historyCreated: boolean;
};

/**
 * Batch-save the full block list of a page (the block editor sends its
 * complete document state). Diffs against the stored blocks by id:
 *
 *   - blocks without id (or with an unknown id) are inserted
 *   - blocks whose content/type/meta/position changed are updated
 *   - stored blocks missing from the payload are deleted
 *
 * Existing fractional-index positions are reused where the relative order
 * still holds, so an unchanged list results in zero row writes. The page's
 * `text` cache is re-materialized, `contentMode` switches to "blocks", a
 * coalesced history snapshot of the previous state is written, and the
 * embedding mirror is re-synced (if enabled).
 */
export const syncKnowledgeTextBlocks = async (
  knowledgeTextId: string,
  blocks: KnowledgeTextBlockInput[],
  context: Context,
  options?: SyncKnowledgeTextBlocksOptions
): Promise<SyncKnowledgeTextBlocksResult> => {
  // Postgres cannot store NUL bytes; strip them before diffing so both the
  // block rows and the materialized `text` cache stay storable (matches the
  // sanitizing in createKnowledgeText/updateKnowledgeText)
  blocks = blocks.map((block) => ({
    ...block,
    content: stripNullBytes(block.content),
  }));

  const page = await getKnowledgeTextById(knowledgeTextId, context);
  await checkKnowledgeTextWritePermission(page, context);

  const db = getDb();
  const existing = await db
    .select()
    .from(knowledgeTextBlock)
    .where(eq(knowledgeTextBlock.knowledgeTextId, knowledgeTextId))
    .orderBy(asc(knowledgeTextBlock.position));
  const existingById = new Map(existing.map((b) => [b.id, b]));

  // resolve which incoming blocks refer to a stored block
  const desired = blocks.map((input) => ({
    input,
    current: input.id ? (existingById.get(input.id) ?? null) : null,
  }));

  // reuse positions where the order is unchanged, generate keys for the rest
  const positions = assignPositions(
    desired.map((d) => ({ position: d.current?.position ?? null }))
  );

  const inserts: (typeof knowledgeTextBlock.$inferInsert)[] = [];
  const updates: {
    id: string;
    content: string;
    type: "markdown" | "html";
    position: string;
    meta: Record<string, unknown>;
  }[] = [];

  const seenIds = new Set<string>();
  desired.forEach(({ input, current }, i) => {
    const position = positions[i]!;
    if (!current) {
      inserts.push({
        // a client-generated uuid is kept so the editor can track its blocks
        ...(input.id ? { id: input.id } : {}),
        knowledgeTextId,
        tenantId: page.tenantId,
        type: input.type,
        content: input.content,
        position,
        meta: input.meta ?? {},
      });
      return;
    }
    seenIds.add(current.id);
    const metaChanged =
      JSON.stringify(input.meta ?? {}) !== JSON.stringify(current.meta ?? {});
    if (
      current.content !== input.content ||
      current.type !== input.type ||
      current.position !== position ||
      metaChanged
    ) {
      updates.push({
        id: current.id,
        content: input.content,
        type: input.type,
        position,
        meta: input.meta ?? {},
      });
    }
  });

  const deleteIds = existing
    .filter((b) => !seenIds.has(b.id))
    .map((b) => b.id);

  const newText = materializeBlocksText(blocks);
  const pageChanged =
    page.text !== newText || page.contentMode !== "blocks";
  const nothingToDo =
    inserts.length === 0 &&
    updates.length === 0 &&
    deleteIds.length === 0 &&
    !pageChanged;

  let historyCreated = false;
  if (!nothingToDo) {
    // snapshot the PREVIOUS state before touching anything
    historyCreated = await snapshotHistoryCoalesced(
      page,
      existing,
      options?.historyCoalesceMinutes ?? HISTORY_COALESCE_MINUTES
    );

    await db.transaction(async (trx) => {
      if (deleteIds.length > 0) {
        await trx
          .delete(knowledgeTextBlock)
          .where(inArray(knowledgeTextBlock.id, deleteIds));
      }
      // apply position updates before inserts so the unique
      // (page, position) index never sees a transient collision
      for (const update of updates) {
        await trx
          .update(knowledgeTextBlock)
          .set({
            content: update.content,
            type: update.type,
            position: update.position,
            meta: update.meta,
            updatedAt: sql`now()`,
          })
          .where(eq(knowledgeTextBlock.id, update.id));
      }
      if (inserts.length > 0) {
        await trx.insert(knowledgeTextBlock).values(inserts);
      }
      await trx
        .update(knowledgeText)
        .set({
          text: newText,
          contentMode: "blocks",
          updatedAt: sql`now()`,
        })
        .where(eq(knowledgeText.id, knowledgeTextId));
    });

    await runBookkeepingSafe("links", () =>
      syncKnowledgeTextLinks({
        id: knowledgeTextId,
        tenantId: page.tenantId,
        text: newText,
      })
    );
    await runBookkeepingSafe("file-references", () =>
      syncKnowledgeTextFileReferences({
        id: knowledgeTextId,
        tenantId: page.tenantId,
        text: newText,
      })
    );

    if (page.embeddingEnabled && !options?.skipEmbeddingSync) {
      await syncKnowledgeTextEmbeddingSafe(knowledgeTextId, page.tenantId);
    }
  }

  const finalPage = await getKnowledgeTextById(knowledgeTextId, context);
  const finalBlocks = await db
    .select()
    .from(knowledgeTextBlock)
    .where(eq(knowledgeTextBlock.knowledgeTextId, knowledgeTextId))
    .orderBy(asc(knowledgeTextBlock.position));

  return {
    knowledgeText: finalPage,
    blocks: finalBlocks,
    changes: {
      inserted: inserts.length,
      updated: updates.length,
      deleted: deleteIds.length,
    },
    historyCreated,
  };
};

/**
 * Convert a legacy `contentMode = "text"` page into block mode by wrapping
 * its text into a single markdown block. No-op (returns existing blocks)
 * for pages already in block mode.
 */
export const convertKnowledgeTextToBlocks = async (
  knowledgeTextId: string,
  context: Context
): Promise<SyncKnowledgeTextBlocksResult> => {
  const page = await getKnowledgeTextById(knowledgeTextId, context);

  if (page.contentMode === "blocks") {
    const blocks = await getKnowledgeTextBlocks(knowledgeTextId, context);
    return {
      knowledgeText: page,
      blocks,
      changes: { inserted: 0, updated: 0, deleted: 0 },
      historyCreated: false,
    };
  }

  const initialBlocks: KnowledgeTextBlockInput[] =
    page.text.trim().length > 0
      ? [{ type: "markdown", content: page.text }]
      : [];

  return await syncKnowledgeTextBlocks(
    knowledgeTextId,
    initialBlocks,
    context,
    // conversion should always leave a restore point of the text version
    { historyCoalesceMinutes: 0 }
  );
};
