import { sql } from "drizzle-orm";
import {
  pgEnum,
  text,
  timestamp,
  uuid,
  integer,
  varchar,
  jsonb,
  vector,
  index,
  uniqueIndex,
  unique,
  check,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { pgBaseTable } from ".";
import { tenants, teams, users } from "./users";
import { files } from "./files";
import {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-valibot";

// Enum for the type of file source
export const fileSourceTypeEnum = pgEnum("file_source_type", [
  "db",
  "local",
  "url",
  "text",
  "finetuning",
  "plugin",
  "external",
]);

// How the content of a knowledgeText entry is stored:
// - "text": single markdown blob in the `text` column (legacy / simple entries)
// - "blocks": content lives in knowledge_text_block rows; `text` is a
//   materialized cache assembled from the blocks on every block save
export const knowledgeContentModeEnum = pgEnum("knowledge_content_mode", [
  "text",
  "blocks",
]);

// Type of a single content block inside a knowledgeText page
export const knowledgeBlockTypeEnum = pgEnum("knowledge_block_type", [
  "markdown",
  "html",
]);

// How a knowledge page's AI summary is maintained:
// - "auto":   regenerated in the background once the page goes quiet
// - "manual": user-provided text; auto-generation never overwrites it
// - "off":    no summary for this page
export const knowledgeSummaryModeEnum = pgEnum("knowledge_summary_mode", [
  "auto",
  "manual",
  "off",
]);

// Explicit publishing intent of a knowledgeText page, as set by a human. NULL (the
// default) means "inherit from the parent page" — which is why this is a
// three-valued concept and not a boolean:
// - "public":   publish this page and, by inheritance, its whole subtree
// - "excluded": keep this page (and its subtree) internal even when an
//               ancestor is published — the escape hatch for a single
//               internal page below an otherwise public branch
//
// This column records INTENT only. The value actually used for filtering is
// the derived `publicEffective` flag below; see lib/knowledge/knowledge-text-public.ts.
export const knowledgePublicModeEnum = pgEnum("knowledge_public_mode", [
  "public",
  "excluded",
]);

// Table to store input texts
export const knowledgeText = pgBaseTable(
  "knowledge_text",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tenantWide: boolean("tenant_wide").notNull().default(false),
    // optional team id to organize knowledge entries into teams.
    // security feature to limit access to knowledge entries
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    // optional user id to assign knowledge entries to a user.
    // security feature to limit access to knowledge entries
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    // parentId: ONLY for Wiki hierarchy (parent-child relationships in tree)
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => knowledgeText.id,
      { onDelete: "cascade" }
    ),
    text: text("text").notNull().default(""),
    title: varchar("title", { length: 1000 }).notNull().default(""),
    meta: jsonb("meta").notNull().default("{}"),
    hidden: boolean("hidden").notNull().default(false),
    // "text" = plain markdown blob; "blocks" = block-editor page whose content
    // lives in knowledge_text_block and is materialized into `text` on save
    contentMode: knowledgeContentModeEnum("content_mode")
      .notNull()
      .default("text"),
    // fractional-index key for manual ordering among sibling pages in the
    // wiki tree; null = unsorted (falls back to title sort).
    // `text`, not a bounded varchar: keys grow by ~1 character per 4 inserts,
    // and a length limit turns that growth into a hard write failure once it is
    // reached (see MAX_KEY_LENGTH_BEFORE_REBALANCE, which keeps them short).
    position: text("position"),
    // --- AI page summary (the "docstring" of a page) ---
    // A short (1-2 sentence) description of the page, delivered in every
    // list-type response (tree, search, recent-changes, ...) so an agent can
    // tell similar pages apart without opening them. Stored, not generated on
    // the fly. See src/lib/knowledge/summaries.ts.
    summary: text("summary"),
    // How the summary is maintained (auto | manual | off). See the enum above.
    summaryMode: knowledgeSummaryModeEnum("summary_mode")
      .notNull()
      .default("auto"),
    // Set true when the content changes; the debounced sweeper regenerates
    // stale summaries once the page has been quiet for the configured period.
    summaryStale: boolean("summary_stale").notNull().default(false),
    // sha256 of the content at the last generation, so a save that did not
    // change the content (or a revert) clears the flag without an LLM call.
    summaryContentHash: varchar("summary_content_hash", { length: 64 }),
    // When the summary was last (re)generated, and by which model.
    summaryUpdatedAt: timestamp("summary_updated_at", { mode: "string" }),
    summaryModel: varchar("summary_model", { length: 128 }),
    // --- controlled facets ---
    // Small, controlled vocabulary (closed lists configured per tenant in the
    // knowledge config, see knowledge-config.ts) — NOT free tags. Delivered in every
    // list-type response and usable as filter parameters in search / tree /
    // lists / recent-changes. Stored as text validated against the tenant
    // vocabulary on write.
    //
    // Type of page, e.g. "FAQ" | "manual" | "text" | "policy" | "note".
    pageType: varchar("page_type", { length: 64 }),
    // Trust signal, e.g. "draft" | "verified" | "outdated".
    status: varchar("status", { length: 64 }),
    // For status transitions to "verified": when and by whom.
    verifiedAt: timestamp("verified_at", { mode: "string" }),
    verifiedBy: uuid("verified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // Responsibility / point of contact. Distinct from the userId/teamId
    // access fields — an owner need not be the (only) reader.
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ownerTeamId: uuid("owner_team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    // Expiry for time-bound content (price lists, deadlines). Null = no expiry.
    validUntil: timestamp("valid_until", { mode: "string" }),
    // Successor/duplicate resolution: this page "replaces" the referenced page.
    // Self-FK; SET NULL so removing the superseded page doesn't cascade-delete.
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => knowledgeText.id,
      { onDelete: "set null" }
    ),
    // --- catalog attributes ---
    // Per-tenant key-value attributes, e.g. {"typ":"Datenblatt","hersteller":"Miele"}.
    // The allowed keys (and optionally a closed value list per key) are defined
    // in the tenant knowledge config and validated on write (facets.ts).
    // Filterable via jsonb containment (attributes @> '{...}'), backed by the
    // GIN index below. Distinct from `meta`, which holds technical bookkeeping.
    attributes: jsonb("attributes")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    // --- public publishing (anonymous, unauthenticated read access) ---
    // Explicit intent set by a human; NULL means "inherit from the parent".
    // See knowledgePublicModeEnum above.
    publicMode: knowledgePublicModeEnum("public_mode"),
    // DERIVED from publicMode along the parentId chain — never set this by
    // hand. Maintained on every write that can change publishing (create,
    // move, publish/unpublish) by lib/knowledge/knowledge-text-public.ts, and
    // rebuildable from scratch with recomputePublicEffectiveForTenant().
    //
    // It exists as a stored, indexed column on purpose: the read-side
    // visibility filter is pure SQL and sits in hot paths (including the
    // vector-search leg next to the HNSW index), so resolving inheritance
    // per query with a recursive CTE would be paid on every read.
    //
    // Defaults to false, so nothing becomes public by accident — a fresh
    // migration leaves the whole knowledge base internal.
    publicEffective: boolean("public_effective").notNull().default(false),
    // opt-in: mirror this page into the RAG pipeline (knowledge_entry +
    // knowledge_chunks) so it shows up in similarity search
    embeddingEnabled: boolean("embedding_enabled").notNull().default(false),
    // link to the knowledge_entry created by the embedding sync, so re-syncs
    // replace chunks in place and page deletion can clean the entry up
    knowledgeEntryId: uuid("knowledge_entry_id").references(
      (): AnyPgColumn => knowledgeEntry.id,
      { onDelete: "set null" }
    ),
    // Audit: who created this page and who made the most recent change.
    // These are distinct from `userId` (which is an ownership/access field).
    // ON DELETE SET NULL so deleting a user keeps the page but drops the
    // pointer; null for service/sync writes that run without a user context.
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { mode: "string" }),
  },
  (knowledgeText) => [
    index("knowledge_text_created_at_idx").on(knowledgeText.createdAt),
    index("knowledge_text_updated_at_idx").on(knowledgeText.updatedAt),
    index("knowledge_text_deleted_at_idx").on(knowledgeText.deletedAt),
    index("knowledge_text_title_idx").on(knowledgeText.title),
    index("knowledge_text_tenant_id_idx").on(knowledgeText.tenantId),
    index("knowledge_text_team_id_idx").on(knowledgeText.teamId),
    index("knowledge_text_user_id_idx").on(knowledgeText.userId),
    index("knowledge_text_parent_id_idx").on(knowledgeText.parentId),
    // every public read filters on (tenant, publicEffective); the composite
    // index keeps public reads cheap even in a large, mostly-internal tenant
    index("knowledge_text_public_effective_idx").on(
      knowledgeText.tenantId,
      knowledgeText.publicEffective
    ),
    // full-text search over title + content ('simple' config: language-
    // agnostic, works for mixed German/English wikis).
    //
    // base_safe_tsvector (created in migration 0022) wraps to_tsvector so an
    // oversized document can never abort the row write: it caps the indexed
    // input and falls back to a smaller slice / an empty tsvector when the
    // resulting vector would exceed Postgres' 1MB tsvector limit. The full
    // text always stays in the `text` column — only the search index input
    // is bounded. The search side (knowledge-text-search.ts) must use the
    // exact same expression, otherwise this index is not used.
    index("knowledge_text_fts_idx").using(
      "gin",
      sql`base_safe_tsvector('simple', coalesce(${knowledgeText.title}, '') || ' ' || coalesce(${knowledgeText.text}, ''))`
    ),
    // Partial index for the summary sweeper: it only ever scans stale pages.
    index("knowledge_text_summary_stale_idx")
      .on(knowledgeText.updatedAt)
      .where(sql`${knowledgeText.summaryStale} = true`),
    // facet filters (scoped by tenant).
    index("knowledge_text_page_type_idx").on(
      knowledgeText.tenantId,
      knowledgeText.pageType
    ),
    index("knowledge_text_status_idx").on(
      knowledgeText.tenantId,
      knowledgeText.status
    ),
    // containment filters over the catalog attributes (attributes @> '{...}')
    index("knowledge_text_attributes_idx").using(
      "gin",
      knowledgeText.attributes.op("jsonb_path_ops")
    ),
  ]
);

/**
 * The "CLAUDE.md of the knowledge base": curated orientation an agent is handed
 * at the start of a session (what lives where, conventions, glossary, which
 * areas are authoritative). Surfaced by the knowledge overview endpoint.
 *
 * Exactly one row per tenant, enforced by the unique constraint on tenantId —
 * this used to be a boolean flag on knowledgeText, which modelled a per-tenant
 * singleton as a property of every single page and left "which page wins?"
 * up to a query's ORDER BY.
 */
export const knowledgeAgentInstructions = pgBaseTable(
  "knowledge_agent_instructions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Markdown. Empty string is a legitimate state (configured, then cleared);
    // "no instructions at all" is the absence of the row.
    content: text("content").notNull().default(""),
    // Audit: who last changed the instructions. SET NULL so deleting a user
    // keeps the instructions but drops the pointer; null for service writes.
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  }
);

export type KnowledgeAgentInstructionsSelect =
  typeof knowledgeAgentInstructions.$inferSelect;
export type KnowledgeAgentInstructionsInsert =
  typeof knowledgeAgentInstructions.$inferInsert;

export const knowledgeAgentInstructionsSchema = createSelectSchema(
  knowledgeAgentInstructions
);

// History table for knowledgeText versions
export const knowledgeTextHistory = pgBaseTable(
  "knowledge_text_history",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    knowledgeTextId: uuid("knowledge_text_id")
      .notNull()
      .references(() => knowledgeText.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tenantWide: boolean("tenant_wide").notNull().default(false),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"), // Store the parentId at time of history creation
    text: text("text").notNull().default(""),
    title: varchar("title", { length: 1000 }).notNull().default(""),
    meta: jsonb("meta").notNull().default("{}"),
    hidden: boolean("hidden").notNull().default(false),
    contentMode: knowledgeContentModeEnum("content_mode")
      .notNull()
      .default("text"),
    // Snapshot of the page's blocks at the time of history creation
    // (null for plain text entries)
    blocks: jsonb("blocks").$type<KnowledgeTextBlockSnapshot[] | null>(),
    // Audit snapshot of the archived version's authorship. Plain uuid columns
    // (no FK) so this history stays immutable and survives user deletion:
    //   - createdBy: who created the page
    //   - updatedBy: who last edited THIS version
    //   - versionUpdatedAt: when THIS version was last edited (page.updatedAt
    //     at snapshot time). Distinct from `createdAt` below, which is when
    //     this history row itself was written (i.e. when the version was
    //     superseded).
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
    versionUpdatedAt: timestamp("version_updated_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(), // When this history entry was created
  },
  (knowledgeTextHistory) => [
    index("knowledge_text_history_knowledge_text_id_idx").on(
      knowledgeTextHistory.knowledgeTextId
    ),
    index("knowledge_text_history_tenant_id_idx").on(
      knowledgeTextHistory.tenantId
    ),
    index("knowledge_text_history_created_at_idx").on(
      knowledgeTextHistory.createdAt
    ),
  ]
);

export type KnowledgeTextSelect = typeof knowledgeText.$inferSelect;
export type KnowledgeTextInsert = typeof knowledgeText.$inferInsert;

export const knowledgeTextSchema = createSelectSchema(knowledgeText);
export const knowledgeTextInsertSchema = createInsertSchema(knowledgeText);
export const knowledgeTextUpdateSchema = createUpdateSchema(knowledgeText);

export type KnowledgeTextHistorySelect = typeof knowledgeTextHistory.$inferSelect;
export type KnowledgeTextHistoryInsert = typeof knowledgeTextHistory.$inferInsert;

export const knowledgeTextHistorySchema = createSelectSchema(knowledgeTextHistory);
export const knowledgeTextHistoryInsertSchema = createInsertSchema(knowledgeTextHistory);
export const knowledgeTextHistoryUpdateSchema = createUpdateSchema(knowledgeTextHistory);

export type KnowledgeTextMeta = {
  sourceUri?: string;
  textLength?: number;
  includesLocalImages?: boolean; // when the document has mardown ![image](image.png) which can be found in the storage
  // sha256 of the materialized content at the time of the last embedding
  // sync; used to skip re-embedding unchanged pages
  embeddingContentHash?: string;
};

// Shape of a block snapshot stored in knowledge_text_history.blocks
export type KnowledgeTextBlockSnapshot = {
  id: string;
  type: "markdown" | "html";
  content: string;
  position: string;
  meta?: Record<string, unknown>;
};

// Content blocks of a knowledgeText page (contentMode = "blocks").
// One row = one block in the block editor. Ordering inside a page uses
// fractional-index keys (see lib/utils/fractional-index.ts), so moving a
// block is a single-row update instead of renumbering the whole page.
export const knowledgeTextBlock = pgBaseTable(
  "knowledge_text_block",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    knowledgeTextId: uuid("knowledge_text_id")
      .notNull()
      .references(() => knowledgeText.id, { onDelete: "cascade" }),
    // denormalized for direct tenant filtering without a join
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: knowledgeBlockTypeEnum("type").notNull().default("markdown"),
    content: text("content").notNull().default(""),
    // fractional-index key; unique per page, lexicographic order = block order.
    // `text` rather than a bounded varchar — see knowledgeText.position above:
    // a 64-character cap made pages of ~257 blocks permanently unsaveable.
    position: text("position").notNull(),
    // editor props per block, e.g. { language: "ts" } for code blocks
    meta: jsonb("meta").notNull().default("{}"),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("knowledge_text_block_page_position_idx").on(
      table.knowledgeTextId,
      table.position
    ),
    index("knowledge_text_block_knowledge_text_id_idx").on(
      table.knowledgeTextId
    ),
    index("knowledge_text_block_tenant_id_idx").on(table.tenantId),
  ]
);

export type KnowledgeTextBlockSelect = typeof knowledgeTextBlock.$inferSelect;
export type KnowledgeTextBlockInsert = typeof knowledgeTextBlock.$inferInsert;

// Obsidian-style page links between knowledgeText pages, extracted from
// [[Target Title]] / [[Target Title|alias]] markers on every content save.
// targetId is null while the linked title has no matching page yet
// ("phantom link"); it is resolved automatically when such a page appears
// and cleared again (ON DELETE SET NULL) when the target is deleted.
export const knowledgeTextLink = pgBaseTable(
  "knowledge_text_link",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => knowledgeText.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").references(() => knowledgeText.id, {
      onDelete: "set null",
    }),
    // the raw link target as written in the content — survives target
    // deletion and is used to (re-)resolve the link by title
    targetTitle: varchar("target_title", { length: 1000 }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("knowledge_text_link_source_target_unique").on(
      table.sourceId,
      table.targetTitle
    ),
    index("knowledge_text_link_source_id_idx").on(table.sourceId),
    index("knowledge_text_link_target_id_idx").on(table.targetId),
    index("knowledge_text_link_tenant_target_title_idx").on(
      table.tenantId,
      table.targetTitle
    ),
  ]
);

export type KnowledgeTextLinkSelect = typeof knowledgeTextLink.$inferSelect;
export type KnowledgeTextLinkInsert = typeof knowledgeTextLink.$inferInsert;

// Tracks which files (images, attachments in the "knowledge" bucket) are
// referenced by which knowledgeText page. Rebuilt from the page content on
// every save — the same pattern as page links. Files without any reference
// get an expiry (grace period) and are removed by the cleanup cron, so no
// orphaned blobs accumulate.
export const knowledgeTextFile = pgBaseTable(
  "knowledge_text_file",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    knowledgeTextId: uuid("knowledge_text_id")
      .notNull()
      .references(() => knowledgeText.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("knowledge_text_file_page_file_unique").on(
      table.knowledgeTextId,
      table.fileId
    ),
    index("knowledge_text_file_knowledge_text_id_idx").on(
      table.knowledgeTextId
    ),
    index("knowledge_text_file_file_id_idx").on(table.fileId),
    index("knowledge_text_file_tenant_id_idx").on(table.tenantId),
  ]
);

export type KnowledgeTextFileSelect = typeof knowledgeTextFile.$inferSelect;
export type KnowledgeTextFileInsert = typeof knowledgeTextFile.$inferInsert;

export const knowledgeTextFileSchema = createSelectSchema(knowledgeTextFile);
export const knowledgeTextFileInsertSchema =
  createInsertSchema(knowledgeTextFile);

export const knowledgeTextLinkSchema = createSelectSchema(knowledgeTextLink);
export const knowledgeTextLinkInsertSchema =
  createInsertSchema(knowledgeTextLink);

export const knowledgeTextBlockSchema = createSelectSchema(knowledgeTextBlock);
export const knowledgeTextBlockInsertSchema =
  createInsertSchema(knowledgeTextBlock);
export const knowledgeTextBlockUpdateSchema =
  createUpdateSchema(knowledgeTextBlock);

// Main table for all knowledge entries
export const knowledgeEntry = pgBaseTable(
  "knowledge_entry",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // optional team id to organize knowledge entries into teams.
    // security feature to limit access to knowledge entries
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    // optional user id to assign knowledge entries to a user.
    // security feature to limit access to knowledge entries
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    // optional assign a document only to my user
    // security feature to limit access to knowledge entries
    userOwned: boolean("user_owned").notNull().default(false),
    // Mirror of knowledgeText.publicEffective for entries created by the
    // knowledgeText embedding sync. Lets similarity search (the retrieval path
    // an unauthenticated consumer uses) filter on published content in the same
    // query as the vector distance, instead of post-filtering a ranked result
    // set.
    //
    // Entries ingested directly (not mirrored from a knowledgeText page) keep
    // the default false and are therefore never public.
    publicEffective: boolean("public_effective").notNull().default(false),
    parentId: uuid("parentId").references(
      (): AnyPgColumn => knowledgeEntry.id,
      {
        onDelete: "cascade",
      }
    ),
    name: varchar("name", { length: 1000 }).notNull(),
    description: text("description"),
    // Optional sha256 (hex) of the source file/content, written by the sync
    // when source hashing is enabled. A re-sync compares this against the new
    // hash to detect an unchanged source and skip re-parsing/re-embedding.
    // Nullable + partial index → zero cost when the feature is off (default).
    sourceHash: varchar("source_hash", { length: 64 }),
    meta: jsonb("meta").$type<KnowledgeTextMeta>().default({}),
    version: integer("version").notNull().default(1),
    versionText: text("version_text").notNull().default("1"),
    hidden: boolean("hidden").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { mode: "string" }),
  },
  (knowledgeEntry) => [
    uniqueIndex("knowledgeentry_name_idx").on(
      knowledgeEntry.name,
      knowledgeEntry.parentId,
      knowledgeEntry.tenantId,
      knowledgeEntry.teamId,
      knowledgeEntry.userId,
      knowledgeEntry.version
    ),
    index("knowledgeentry_created_at_idx").on(knowledgeEntry.createdAt),
    index("knowledgeentry_updated_at_idx").on(knowledgeEntry.updatedAt),
    index("knowledgeentry_deleted_at_idx").on(knowledgeEntry.deletedAt),
    index("knowledgeentry_tenant_id_idx").on(knowledgeEntry.tenantId),
    index("knowledge_entry_team_id_idx").on(knowledgeEntry.teamId),
    index("knowledge_entry_user_id_idx").on(knowledgeEntry.userId),
    // public similarity search filters on (tenant, publicEffective)
    index("knowledge_entry_public_effective_idx").on(
      knowledgeEntry.tenantId,
      knowledgeEntry.publicEffective
    ),
    // Partial index: only rows that opted into source hashing are indexed, so
    // lookups by hash (unchanged-source detection, duplicate analysis) stay
    // fast while the feature-off default carries no index overhead.
    index("knowledge_entry_source_hash_idx")
      .on(knowledgeEntry.sourceHash)
      .where(sql`source_hash IS NOT NULL`),
    check(
      "knowledge_entry_description_max_length",
      sql`length(description) <= 10000`
    ),
  ]
);

export type KnowledgeEntrySelect = typeof knowledgeEntry.$inferSelect;
export type KnowledgeEntryInsert = typeof knowledgeEntry.$inferInsert;

export const knowledgeEntrySchema = createSelectSchema(knowledgeEntry);
export const knowledgeEntryInsertSchema = createInsertSchema(knowledgeEntry);
export const knowledgeEntryUpdateSchema = createUpdateSchema(knowledgeEntry);

// Table to save the raw text chunks for each knowledge entry

export type KnowledgeChunkMeta = {
  sourceUri?: string;
  textLength?: number;
  page?: number;
  /**
   * Id of the knowledge_text_block this chunk starts in (wiki pages in block
   * mode only). Written by the block-provenance mapper during the embedding
   * sync so search/RAG hits can deep-link to the exact block in the rendered
   * document. Absent for non-block sources (PDF/URL/file imports).
   */
  blockId?: string;
};

export const knowledgeChunks = pgBaseTable(
  "knowledge_chunks",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    knowledgeEntryId: uuid("knowledge_entry_id")
      .notNull()
      .references(() => knowledgeEntry.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    header: varchar("header", { length: 1000 }),
    order: integer("order").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "string" })
      .notNull()
      .defaultNow(),
    embeddingModel: varchar("embedding_model", { length: 255 })
      .notNull()
      .default("")
      .notNull(),
    dimensions: integer("dimensions").notNull().default(0),
    textEmbedding1536: vector("text_embedding_1536", {
      dimensions: 1536,
    }),
    textEmbedding1024: vector("text_embedding_1024", {
      dimensions: 1024,
    }),
    meta: jsonb("meta").$type<KnowledgeChunkMeta>().default({}),
  },
  (knowledgeChunks) => [
    index("knowledge_chunks_knowledge_entry_id_idx").on(
      knowledgeChunks.knowledgeEntryId
    ),
    index("knowledge_chunks_created_at_idx").on(knowledgeChunks.createdAt),
    index("knowledge_chunks_header_idx").on(knowledgeChunks.header),
    // full-text search over header + chunk text for the lexical leg of the
    // hybrid RAG search ('simple' config: language-agnostic, mixed German/
    // English content). Uses the same base_safe_tsvector wrapper as
    // knowledge_text_fts_idx so oversized chunks can never abort a row write.
    // The search side (similarity-search.ts) must use the exact same
    // expression, otherwise this index is not used.
    index("knowledge_chunks_fts_idx").using(
      "gin",
      sql`base_safe_tsvector('simple', coalesce(${knowledgeChunks.header}, '') || ' ' || coalesce(${knowledgeChunks.text}, ''))`
    ),
    // ANN indexes for similarity search. Partial (per non-null column) so each
    // index only carries the rows that actually hold a vector of its size.
    // Opclass is cosine — every query side must use the `<=>` operator,
    // otherwise these indexes are not used.
    index("knowledge_chunks_embedding_1024_hnsw_idx")
      .using(
        "hnsw",
        knowledgeChunks.textEmbedding1024.op("vector_cosine_ops")
      )
      .where(sql`text_embedding_1024 IS NOT NULL`),
    index("knowledge_chunks_embedding_1536_hnsw_idx")
      .using(
        "hnsw",
        knowledgeChunks.textEmbedding1536.op("vector_cosine_ops")
      )
      .where(sql`text_embedding_1536 IS NOT NULL`),
    check(
      "knowledge_chunks_embedding_required",
      sql`text_embedding_1536 IS NOT NULL OR text_embedding_1024 IS NOT NULL`
    ),
  ]
);

export type KnowledgeChunksSelect = typeof knowledgeChunks.$inferSelect;
export type KnowledgeChunksInsert = typeof knowledgeChunks.$inferInsert;

export const knowledgeChunksSchema = createSelectSchema(knowledgeChunks);
export const knowledgeChunksInsertSchema = createInsertSchema(knowledgeChunks);
export const knowledgeChunksUpdateSchema = createUpdateSchema(knowledgeChunks);

export const knowledgeEntryRelations = relations(
  knowledgeEntry,
  ({ many, one }) => ({
    knowledgeChunks: many(knowledgeChunks),
    tenant: one(tenants, {
      fields: [knowledgeEntry.tenantId],
      references: [tenants.id],
    }),
    team: one(teams, {
      fields: [knowledgeEntry.teamId],
      references: [teams.id],
    }),
    user: one(users, {
      fields: [knowledgeEntry.userId],
      references: [users.id],
    }),
  })
);

export const knowledgeChunksRelations = relations(
  knowledgeChunks,
  ({ one }) => ({
    knowledgeEntry: one(knowledgeEntry, {
      fields: [knowledgeChunks.knowledgeEntryId],
      references: [knowledgeEntry.id],
    }),
  })
);

export const knowledgeTextRelations = relations(
  knowledgeText,
  ({ many, one }) => ({
    tenant: one(tenants, {
      fields: [knowledgeText.tenantId],
      references: [tenants.id],
    }),
    team: one(teams, {
      fields: [knowledgeText.teamId],
      references: [teams.id],
    }),
    user: one(users, {
      fields: [knowledgeText.userId],
      references: [users.id],
    }),
    history: many(knowledgeTextHistory),
    blocks: many(knowledgeTextBlock),
    knowledgeEntry: one(knowledgeEntry, {
      fields: [knowledgeText.knowledgeEntryId],
      references: [knowledgeEntry.id],
    }),
  })
);

export const knowledgeTextLinkRelations = relations(
  knowledgeTextLink,
  ({ one }) => ({
    source: one(knowledgeText, {
      fields: [knowledgeTextLink.sourceId],
      references: [knowledgeText.id],
    }),
    target: one(knowledgeText, {
      fields: [knowledgeTextLink.targetId],
      references: [knowledgeText.id],
    }),
  })
);

export const knowledgeTextBlockRelations = relations(
  knowledgeTextBlock,
  ({ one }) => ({
    knowledgeText: one(knowledgeText, {
      fields: [knowledgeTextBlock.knowledgeTextId],
      references: [knowledgeText.id],
    }),
    tenant: one(tenants, {
      fields: [knowledgeTextBlock.tenantId],
      references: [tenants.id],
    }),
  })
);

export const knowledgeTextHistoryRelations = relations(
  knowledgeTextHistory,
  ({ one }) => ({
    knowledgeText: one(knowledgeText, {
      fields: [knowledgeTextHistory.knowledgeTextId],
      references: [knowledgeText.id],
    }),
    tenant: one(tenants, {
      fields: [knowledgeTextHistory.tenantId],
      references: [tenants.id],
    }),
    team: one(teams, {
      fields: [knowledgeTextHistory.teamId],
      references: [teams.id],
    }),
    user: one(users, {
      fields: [knowledgeTextHistory.userId],
      references: [users.id],
    }),
  })
);
