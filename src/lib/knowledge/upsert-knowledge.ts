/**
 * Upsert support for knowledge entries.
 *
 * Sync-style ingestion (URL crawls, file-system mirrors, external API
 * imports) re-ingests the same logical document multiple times. The plain
 * `extractKnowledgeFromText` helper always **inserts** a new row, so naive
 * sync loops produce ever-growing duplicates.
 *
 * This module adds three primitives that solve that:
 *
 *   - `findKnowledgeEntryBySourceIdentifier` — look up an existing entry by
 *     a stable external id (URL, GUID, file path, …) stored in
 *     `meta.sourceIdentifier`. The lookup can be scoped further via the
 *     `matchScope` `meta` filters.
 *
 *   - `upsertKnowledgeFromText` — insert if no match, **replace** text +
 *     chunks + meta in place if a match exists. The entry's primary key is
 *     preserved across updates so foreign-key references (annotations,
 *     bookmarks, etc.) stay valid.
 *
 *   - `deleteOrphanedKnowledgeEntries` — at the end of a sync run, delete
 *     every entry inside `matchScope` whose `sourceIdentifier` is NOT in
 *     the active keep-set. Also cleans up legacy entries with no
 *     `sourceIdentifier` set, so callers can migrate to the new sync model
 *     without a manual data-fixup step.
 *
 * Together these turn the sync from "delete-all + create-all" into a
 * proper diff: unchanged URLs keep their primary key, changed URLs are
 * updated in place, removed URLs are cleaned up.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  knowledgeChunks,
  knowledgeEntry,
  type KnowledgeChunksInsert,
  type KnowledgeEntrySelect,
} from "../db/schema/knowledge";
import type { ChunkWithEmbedding } from "../types/chunks";
import type { PageContent } from "./parsing/pdf/types";
import type { FileSourceType } from "../storage";
import { splitTextIntoSectionsOrChunks } from "./splitter";
import { generateEmbedding } from "./embedding";
import { extractKnowledgeFromText } from "./add-knowledge";
import log from "../log";

/** JSON key used in `knowledge_entry.meta` to identify the external source. */
export const SOURCE_IDENTIFIER_META_KEY = "sourceIdentifier";

type MatchScope = Record<string, string>;

/**
 * Build a `(meta->>$key) = $value` SQL filter that is safe against SQL
 * injection of the JSON key by going through `jsonb_extract_path_text`,
 * which takes the path elements as parameters rather than identifiers.
 */
const metaEquals = (key: string, value: string) =>
  sql`jsonb_extract_path_text(${knowledgeEntry.meta}, ${key}) = ${value}`;

const metaIsNull = (key: string) =>
  sql`jsonb_extract_path_text(${knowledgeEntry.meta}, ${key}) IS NULL`;

/**
 * Find an existing knowledge entry whose `meta.sourceIdentifier` matches
 * `sourceIdentifier`. Optionally restrict the search to entries that also
 * match every `(meta->>key) = value` pair in `matchScope`.
 *
 * Returns `null` if no match is found.
 */
export const findKnowledgeEntryBySourceIdentifier = async (
  tenantId: string,
  sourceIdentifier: string,
  matchScope?: MatchScope
): Promise<KnowledgeEntrySelect | null> => {
  const filters = [
    eq(knowledgeEntry.tenantId, tenantId),
    metaEquals(SOURCE_IDENTIFIER_META_KEY, sourceIdentifier),
  ];

  if (matchScope) {
    for (const [key, value] of Object.entries(matchScope)) {
      filters.push(metaEquals(key, value));
    }
  }

  const result = await getDb()
    .select()
    .from(knowledgeEntry)
    .where(and(...filters))
    .limit(1);

  return result[0] ?? null;
};

const generateChunksAndEmbeddings = async (
  text: string,
  pages: PageContent[] | undefined,
  context: { tenantId: string; userId?: string }
): Promise<ChunkWithEmbedding[]> => {
  const chunks = splitTextIntoSectionsOrChunks(pages || text);

  return await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const embedding = await generateEmbedding(chunk.text, context);
        return { ...chunk, embedding } satisfies ChunkWithEmbedding;
      } catch (e) {
        log.error(`Error generating embedding for chunk: ${chunk.text}`);
        log.debug(`Chunk length: ${chunk.text.length}`);
        throw new Error(
          "Error generating embedding for Chunk with text-length: " +
            chunk.text.length +
            ". " +
            e
        );
      }
    })
  );
};

/**
 * Common signature for the user-facing data of an upsert call. Mirrors the
 * subset of `extractKnowledgeFromText`'s signature that survives a re-sync;
 * fields that are inherently per-call (e.g. `generateSummary`) are left to
 * `extractKnowledgeFromText`.
 */
export type UpsertKnowledgeFromTextInput = {
  tenantId: string;
  /**
   * Stable external identifier (URL, GUID, file path, …). Stored on
   * `meta.sourceIdentifier` and used as the upsert key.
   */
  sourceIdentifier: string;
  title: string;
  text?: string;
  pages?: PageContent[];
  filters?: Record<string, string>;
  metadata?: Record<string, string | number | boolean | undefined>;
  sourceType?: FileSourceType;
  sourceFileBucket?: string;
  sourceId?: string;
  sourceExternalId?: string;
  sourceUrl?: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  includesLocalImages?: boolean;
  /**
   * Optional additional `meta` key/value constraints used both to find the
   * existing entry and (on insert) to set on the new entry. Typical usage
   * is to scope by sync-config: `{ syncConfigId: "<id>" }`, so two sync
   * configs in the same tenant cannot collide on the same URL.
   */
  matchScope?: MatchScope;
};

export type UpsertKnowledgeFromTextResult = {
  id: string;
  ok: true;
  /** `true` if a new entry was created, `false` if an existing entry was replaced. */
  created: boolean;
};

/**
 * Insert-or-replace a knowledge entry identified by a stable
 * `sourceIdentifier`.
 *
 * Behaviour:
 *
 *   - **No match** in the tenant (and `matchScope`, if given) → insert via
 *     `extractKnowledgeFromText`, with `meta.sourceIdentifier` and every
 *     `matchScope` key/value pair merged into `meta`.
 *
 *   - **Match found** → keep the same primary key, replace `name`, `meta`
 *     (merged), all chunks + their embeddings, and bump `updatedAt`.
 *     Existing `knowledgeGroupId` / `teamId` / `userId` / `userOwned`
 *     values are preserved unless explicitly overridden by the caller.
 */
export const upsertKnowledgeFromText = async (
  data: UpsertKnowledgeFromTextInput
): Promise<UpsertKnowledgeFromTextResult> => {
  if (!data.text && (!data.pages || data.pages.length === 0)) {
    throw new Error(
      "upsertKnowledgeFromText requires either `text` or non-empty `pages`"
    );
  }

  const existing = await findKnowledgeEntryBySourceIdentifier(
    data.tenantId,
    data.sourceIdentifier,
    data.matchScope
  );

  // ----- Insert path ------------------------------------------------------
  if (!existing) {
    const result = await extractKnowledgeFromText({
      ...data,
      // Store the upsert key + scope inside `meta` so the next sync run can
      // find this entry again.
      metadata: {
        ...(data.metadata ?? {}),
        ...(data.matchScope ?? {}),
        [SOURCE_IDENTIFIER_META_KEY]: data.sourceIdentifier,
      },
    });
    return { id: result.id, ok: true, created: true };
  }

  // ----- Update / replace path -------------------------------------------
  const fullText =
    data.text ?? data.pages!.map((p) => p.text).join("\n\n");

  // Re-chunk + re-embed with the new text BEFORE we touch the DB so a
  // failure here doesn't leave a half-updated entry behind.
  const allEmbeddings = await generateChunksAndEmbeddings(
    fullText,
    data.pages,
    { tenantId: data.tenantId, userId: data.userId }
  );

  const db = getDb();

  // Drop old chunks (their embeddings are now stale).
  await db
    .delete(knowledgeChunks)
    .where(eq(knowledgeChunks.knowledgeEntryId, existing.id));

  // Merge meta: previous → caller metadata → matchScope → upsert key.
  // Later writers win, so the upsert key is always authoritative.
  const previousMeta = (existing.meta ?? {}) as Record<string, unknown>;
  const mergedMeta: Record<string, unknown> = {
    ...previousMeta,
    ...(data.metadata ?? {}),
    ...(data.matchScope ?? {}),
    [SOURCE_IDENTIFIER_META_KEY]: data.sourceIdentifier,
    textLength: fullText.length,
    ...(data.includesLocalImages !== undefined
      ? { includesLocalImages: data.includesLocalImages }
      : {}),
    ...(data.pages ? { pageCount: data.pages.length } : {}),
  };

  const updateSet: Record<string, unknown> = {
    name: data.title,
    meta: mergedMeta,
    updatedAt: new Date().toISOString(),
  };
  if (data.knowledgeGroupId !== undefined) {
    updateSet.knowledgeGroupId = data.knowledgeGroupId;
  }
  if (data.teamId !== undefined) updateSet.teamId = data.teamId;
  if (data.userId !== undefined) updateSet.userId = data.userId;
  if (data.userOwned !== undefined) updateSet.userOwned = data.userOwned;

  await db
    .update(knowledgeEntry)
    .set(updateSet)
    .where(eq(knowledgeEntry.id, existing.id));

  // Insert the freshly-embedded chunks.
  await Promise.all(
    allEmbeddings.map((e) => {
      const insert: KnowledgeChunksInsert = {
        knowledgeEntryId: existing.id,
        text: e.text,
        header: e.header,
        order: e.order,
        embeddingModel: e.embedding.model,
        textEmbedding1536:
          e.embedding.dimensions === 1536 ? e.embedding.embedding : null,
        textEmbedding1024:
          e.embedding.dimensions === 1024 ? e.embedding.embedding : null,
        meta: e.meta,
      };
      return db.insert(knowledgeChunks).values(insert);
    })
  );

  log.debug(
    `Upserted knowledge entry ${existing.id} (replaced); ${allEmbeddings.length} chunks`
  );

  return { id: existing.id, ok: true, created: false };
};

export type DeleteOrphanedKnowledgeEntriesInput = {
  tenantId: string;
  /**
   * `sourceIdentifier` values that should be **kept**. Every entry inside
   * `matchScope` whose `sourceIdentifier` is missing or NOT in this list
   * will be deleted (cascades to its chunks).
   */
  keepSourceIdentifiers: string[];
  /**
   * Optional `meta` key/value filter that limits the cleanup to a specific
   * subset of entries — typically `{ syncConfigId: "<id>" }`, so a sync
   * never deletes entries that don't belong to it.
   *
   * If omitted the cleanup operates on **every** entry in the tenant. Be
   * careful — this is rarely what you want.
   */
  matchScope?: MatchScope;
};

export type DeleteOrphanedKnowledgeEntriesResult = {
  deletedIds: string[];
  /** Number of deleted entries (convenience alias for `deletedIds.length`). */
  deleted: number;
};

/**
 * Delete every knowledge entry inside `matchScope` whose
 * `sourceIdentifier` is missing or not in `keepSourceIdentifiers`.
 *
 * Returns the ids of the deleted entries. Foreign-key cascades take care
 * of the associated chunks.
 *
 * This is the "diff out the orphans" step of a sync run. Combined with
 * `upsertKnowledgeFromText` it gives true incremental sync semantics:
 * unchanged sources keep their PK, changed sources are replaced in place,
 * dropped sources are removed.
 */
export const deleteOrphanedKnowledgeEntries = async (
  data: DeleteOrphanedKnowledgeEntriesInput
): Promise<DeleteOrphanedKnowledgeEntriesResult> => {
  const filters = [eq(knowledgeEntry.tenantId, data.tenantId)];

  if (data.matchScope) {
    for (const [key, value] of Object.entries(data.matchScope)) {
      filters.push(metaEquals(key, value));
    }
  }

  if (data.keepSourceIdentifiers.length > 0) {
    const inList = sql.join(
      data.keepSourceIdentifiers.map((s) => sql`${s}`),
      sql`, `
    );
    // Anything inside matchScope that is either un-tagged (legacy entries
    // from before the upsert refactor) or tagged with a stale identifier
    // is an orphan and gets deleted.
    filters.push(
      sql`(${metaIsNull(SOURCE_IDENTIFIER_META_KEY)} OR jsonb_extract_path_text(${knowledgeEntry.meta}, ${SOURCE_IDENTIFIER_META_KEY}) NOT IN (${inList}))`
    );
  }
  // If keep-set is empty: delete EVERY entry inside matchScope. The caller
  // explicitly opted into this by passing an empty array.

  const deleted = await getDb()
    .delete(knowledgeEntry)
    .where(and(...filters))
    .returning({ id: knowledgeEntry.id });

  return {
    deletedIds: deleted.map((d) => d.id),
    deleted: deleted.length,
  };
};
