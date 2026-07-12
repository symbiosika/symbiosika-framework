/**
 * Sync-style ingestion for knowledgeText wiki pages.
 *
 * Mirrors the proven knowledge-entry sync model (see upsert-knowledge.ts)
 * on the wiki level: external sources (crawls, file mirrors, API imports)
 * re-ingest the same logical documents repeatedly, identified by a stable
 * `sourceIdentifier` stored in the page meta.
 *
 *   - `upsertKnowledgeTextFromSource` — insert if unknown, update in place
 *     if the content changed, no-op if unchanged. The page keeps its id
 *     across updates, so wikilinks, backlinks, history and the embedding
 *     mirror stay intact.
 *
 *   - `deleteOrphanedKnowledgeTexts` — at the end of a sync run, delete
 *     every synced page (inside the given scope) whose identifier is no
 *     longer in the active keep-set. Pages WITHOUT a sourceIdentifier are
 *     never touched — regular wiki pages are not part of any sync.
 */

import { and, eq, sql, isNotNull } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import {
  createKnowledgeText,
  updateKnowledgeText,
  deleteKnowledgeText,
} from "./knowledge-texts";
import { syncKnowledgeTextBlocks } from "./knowledge-text-blocks";

/** JSON key in `knowledge_text.meta` identifying the external source
 *  (same key the knowledge-entry sync uses) */
export const TEXT_SOURCE_IDENTIFIER_META_KEY = "sourceIdentifier";

type MatchScope = Record<string, string>;

const metaEquals = (key: string, value: string) =>
  sql`jsonb_extract_path_text(${knowledgeText.meta}, ${key}) = ${value}`;

export type UpsertKnowledgeTextFromSourceInput = {
  tenantId: string;
  /** stable external identifier (URL, GUID, file path, …) */
  sourceIdentifier: string;
  title: string;
  text: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  tenantWide?: boolean;
  parentId?: string;
  embeddingEnabled?: boolean;
  /**
   * Additional meta key/value constraints used to find the existing page
   * and (on insert) stored on the new page — scope by sync config so two
   * syncs in the same tenant cannot collide on the same identifier.
   */
  matchScope?: MatchScope;
  /** extra meta merged into the page meta on insert */
  meta?: Record<string, unknown>;
};

export type UpsertKnowledgeTextFromSourceResult = {
  id: string;
  created: boolean;
  /** false when the content was identical and nothing was written */
  changed: boolean;
};

/** Find a synced page by its stable source identifier (+ optional scope) */
export const findKnowledgeTextBySourceIdentifier = async (
  tenantId: string,
  sourceIdentifier: string,
  matchScope?: MatchScope
) => {
  const filters = [
    eq(knowledgeText.tenantId, tenantId),
    metaEquals(TEXT_SOURCE_IDENTIFIER_META_KEY, sourceIdentifier),
    ...Object.entries(matchScope ?? {}).map(([key, value]) =>
      metaEquals(key, value)
    ),
  ];
  const rows = await getDb()
    .select()
    .from(knowledgeText)
    .where(and(...filters))
    .limit(1);
  return rows[0] ?? null;
};

/**
 * Insert-or-update a wiki page identified by a stable `sourceIdentifier`.
 */
export const upsertKnowledgeTextFromSource = async (
  data: UpsertKnowledgeTextFromSourceInput
): Promise<UpsertKnowledgeTextFromSourceResult> => {
  const context = {
    tenantId: data.tenantId,
    userId: data.userId,
    teamId: data.teamId,
    workspaceId: data.workspaceId,
    includeHidden: true,
  };

  const existing = await findKnowledgeTextBySourceIdentifier(
    data.tenantId,
    data.sourceIdentifier,
    data.matchScope
  );

  // ----- insert -----------------------------------------------------------
  if (!existing) {
    const page = await createKnowledgeText({
      tenantId: data.tenantId,
      userId: data.userId,
      teamId: data.teamId,
      tenantWide: data.tenantWide ?? false,
      parentId: data.parentId,
      title: data.title,
      text: data.text,
      embeddingEnabled: data.embeddingEnabled ?? false,
      meta: {
        ...(data.meta ?? {}),
        ...(data.matchScope ?? {}),
        [TEXT_SOURCE_IDENTIFIER_META_KEY]: data.sourceIdentifier,
      },
    });
    return { id: page.id, created: true, changed: true };
  }

  // ----- unchanged --------------------------------------------------------
  if (existing.title === data.title && existing.text === data.text) {
    return { id: existing.id, created: false, changed: false };
  }

  // ----- update in place --------------------------------------------------
  if (existing.contentMode === "blocks") {
    // the page mirrors an external source: replace its blocks with the new
    // content (single markdown block); block sync refreshes text cache,
    // links and the embedding mirror
    await syncKnowledgeTextBlocks(
      existing.id,
      data.text.trim().length > 0
        ? [{ type: "markdown", content: data.text }]
        : [],
      context,
      // sync runs are batch jobs — always leave a restore point
      { historyCoalesceMinutes: 0 }
    );
    if (existing.title !== data.title) {
      await updateKnowledgeText(existing.id, { title: data.title }, context);
    }
  } else {
    await updateKnowledgeText(
      existing.id,
      { title: data.title, text: data.text },
      context
    );
  }

  return { id: existing.id, created: false, changed: true };
};

/**
 * Delete synced pages whose `sourceIdentifier` is not in the active
 * keep-set. Only pages that HAVE a sourceIdentifier (inside the optional
 * matchScope) are candidates — hand-written wiki pages are never deleted.
 * Deletion goes through deleteKnowledgeText, so blocks, history, links and
 * the mirrored knowledge entry are cleaned up as well.
 */
export const deleteOrphanedKnowledgeTexts = async (opts: {
  tenantId: string;
  /** identifiers still present in the source (pages to keep) */
  activeSourceIdentifiers: string[];
  matchScope?: MatchScope;
}): Promise<{ deleted: number }> => {
  const filters = [
    eq(knowledgeText.tenantId, opts.tenantId),
    isNotNull(
      sql`jsonb_extract_path_text(${knowledgeText.meta}, ${TEXT_SOURCE_IDENTIFIER_META_KEY})`
    ),
    ...Object.entries(opts.matchScope ?? {}).map(([key, value]) =>
      metaEquals(key, value)
    ),
  ];

  const candidates = await getDb()
    .select({
      id: knowledgeText.id,
      meta: knowledgeText.meta,
    })
    .from(knowledgeText)
    .where(and(...filters));

  const keep = new Set(opts.activeSourceIdentifiers);
  const orphans = candidates.filter((row) => {
    const identifier = (row.meta as Record<string, unknown>)?.[
      TEXT_SOURCE_IDENTIFIER_META_KEY
    ];
    return typeof identifier === "string" && !keep.has(identifier);
  });

  for (const orphan of orphans) {
    await deleteKnowledgeText(orphan.id, {
      tenantId: opts.tenantId,
      includeHidden: true,
    });
  }

  return { deleted: orphans.length };
};
