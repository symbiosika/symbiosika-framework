/**
 * Unit tests for the DB-level helpers in `upsert-knowledge.ts`.
 *
 * These tests intentionally exercise only the parts that do **not** call
 * the embedding API (`findKnowledgeEntryBySourceIdentifier`,
 * `deleteOrphanedKnowledgeEntries`). The actual upsert flow itself is
 * covered indirectly by the sync handler integration test that runs
 * against a real backend with mocked Mistral creds.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
  initTests,
  TEST_ADMIN_USER,
  TEST_ORGANISATION_1,
  TEST_ORGANISATION_2,
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { knowledgeEntry } from "../db/schema/knowledge";
import {
  SOURCE_IDENTIFIER_META_KEY,
  deleteOrphanedKnowledgeEntries,
  findKnowledgeEntryBySourceIdentifier,
} from "./upsert-knowledge";

const SYNC_CONFIG_ID = "fa11ba1b-0000-0000-0000-000000000001";
const OTHER_SYNC_CONFIG_ID = "fa11ba1b-0000-0000-0000-000000000002";

const URL_KEPT = "https://example.com/keep";
const URL_UPDATED = "https://example.com/updated";
const URL_DROPPED = "https://example.com/dropped";
const URL_OTHER_SCOPE = "https://example.com/other-scope";

beforeAll(async () => {
  await initTests();
});

const insertEntry = async (
  name: string,
  meta: Record<string, unknown>,
  tenantId: string = TEST_ORGANISATION_1.id
) => {
  const [row] = await getDb()
    .insert(knowledgeEntry)
    .values({
      tenantId,
      userId: TEST_ADMIN_USER.id,
      name,
      // The schema types `meta` as `KnowledgeTextMeta | undefined`, but
      // `jsonb` accepts arbitrary keys at runtime — cast to unknown so the
      // strict type doesn't block the test fixture.
      meta: meta as never,
    })
    .returning();
  if (!row) throw new Error("Failed to insert test entry");
  return row;
};

const cleanupTenantEntries = async () => {
  await getDb()
    .delete(knowledgeEntry)
    .where(eq(knowledgeEntry.tenantId, TEST_ORGANISATION_1.id));
  await getDb()
    .delete(knowledgeEntry)
    .where(eq(knowledgeEntry.tenantId, TEST_ORGANISATION_2.id));
};

describe("findKnowledgeEntryBySourceIdentifier", () => {
  beforeEach(cleanupTenantEntries);
  afterAll(cleanupTenantEntries);

  test("returns null when no entry matches", async () => {
    const result = await findKnowledgeEntryBySourceIdentifier(
      TEST_ORGANISATION_1.id,
      URL_KEPT
    );
    expect(result).toBeNull();
  });

  test("finds the entry by sourceIdentifier within the tenant", async () => {
    const entry = await insertEntry("Keep", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_KEPT,
    });

    const result = await findKnowledgeEntryBySourceIdentifier(
      TEST_ORGANISATION_1.id,
      URL_KEPT
    );

    expect(result?.id).toBe(entry.id);
  });

  test("ignores matches in other tenants", async () => {
    await insertEntry(
      "Other tenant",
      { [SOURCE_IDENTIFIER_META_KEY]: URL_KEPT },
      TEST_ORGANISATION_2.id
    );

    const result = await findKnowledgeEntryBySourceIdentifier(
      TEST_ORGANISATION_1.id,
      URL_KEPT
    );

    expect(result).toBeNull();
  });

  test("respects matchScope (e.g. syncConfigId)", async () => {
    const entryA = await insertEntry("In scope A", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_KEPT,
      syncConfigId: SYNC_CONFIG_ID,
    });
    await insertEntry("In scope B", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_KEPT,
      syncConfigId: OTHER_SYNC_CONFIG_ID,
    });

    const result = await findKnowledgeEntryBySourceIdentifier(
      TEST_ORGANISATION_1.id,
      URL_KEPT,
      { syncConfigId: SYNC_CONFIG_ID }
    );

    expect(result?.id).toBe(entryA.id);
  });
});

describe("deleteOrphanedKnowledgeEntries", () => {
  beforeEach(cleanupTenantEntries);
  afterAll(cleanupTenantEntries);

  test("deletes entries within scope whose sourceIdentifier is not in the keep set", async () => {
    const keep = await insertEntry("Keep", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_KEPT,
      syncConfigId: SYNC_CONFIG_ID,
    });
    const updated = await insertEntry("Updated", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_UPDATED,
      syncConfigId: SYNC_CONFIG_ID,
    });
    const dropped = await insertEntry("Dropped", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_DROPPED,
      syncConfigId: SYNC_CONFIG_ID,
    });

    const result = await deleteOrphanedKnowledgeEntries({
      tenantId: TEST_ORGANISATION_1.id,
      keepSourceIdentifiers: [URL_KEPT, URL_UPDATED],
      matchScope: { syncConfigId: SYNC_CONFIG_ID },
    });

    expect(result.deleted).toBe(1);
    expect(result.deletedIds).toEqual([dropped.id]);

    // Sanity: surviving entries still there.
    const remaining = await getDb()
      .select({ id: knowledgeEntry.id })
      .from(knowledgeEntry)
      .where(eq(knowledgeEntry.tenantId, TEST_ORGANISATION_1.id));
    const remainingIds = remaining.map((r) => r.id).sort();
    expect(remainingIds).toEqual([keep.id, updated.id].sort());
  });

  test("never touches entries from other matchScopes", async () => {
    const insideScope = await insertEntry("In scope", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_DROPPED,
      syncConfigId: SYNC_CONFIG_ID,
    });
    const outsideScope = await insertEntry("Other sync", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_OTHER_SCOPE,
      syncConfigId: OTHER_SYNC_CONFIG_ID,
    });

    const result = await deleteOrphanedKnowledgeEntries({
      tenantId: TEST_ORGANISATION_1.id,
      keepSourceIdentifiers: [],
      matchScope: { syncConfigId: SYNC_CONFIG_ID },
    });

    expect(result.deletedIds).toEqual([insideScope.id]);
    // The other-scope entry must survive.
    const remaining = await getDb()
      .select({ id: knowledgeEntry.id })
      .from(knowledgeEntry)
      .where(eq(knowledgeEntry.id, outsideScope.id));
    expect(remaining).toHaveLength(1);
  });

  test("also removes legacy entries inside the scope that have no sourceIdentifier", async () => {
    // Pre-existing entries from before the upsert refactor: tagged with
    // syncConfigId but missing sourceIdentifier.
    const legacy = await insertEntry("Legacy", {
      syncConfigId: SYNC_CONFIG_ID,
      sourceUri: "https://example.com/legacy",
    });
    const fresh = await insertEntry("Fresh", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_KEPT,
      syncConfigId: SYNC_CONFIG_ID,
    });

    const result = await deleteOrphanedKnowledgeEntries({
      tenantId: TEST_ORGANISATION_1.id,
      keepSourceIdentifiers: [URL_KEPT],
      matchScope: { syncConfigId: SYNC_CONFIG_ID },
    });

    expect(result.deletedIds).toEqual([legacy.id]);

    const survivor = await getDb()
      .select({ id: knowledgeEntry.id })
      .from(knowledgeEntry)
      .where(eq(knowledgeEntry.id, fresh.id));
    expect(survivor).toHaveLength(1);
  });

  test("deletes everything inside matchScope when the keep set is empty", async () => {
    const a = await insertEntry("A", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_KEPT,
      syncConfigId: SYNC_CONFIG_ID,
    });
    const b = await insertEntry("B", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_DROPPED,
      syncConfigId: SYNC_CONFIG_ID,
    });

    const result = await deleteOrphanedKnowledgeEntries({
      tenantId: TEST_ORGANISATION_1.id,
      keepSourceIdentifiers: [],
      matchScope: { syncConfigId: SYNC_CONFIG_ID },
    });

    expect(result.deleted).toBe(2);
    expect(result.deletedIds.sort()).toEqual([a.id, b.id].sort());
  });

  test("never crosses tenant boundaries", async () => {
    const ours = await insertEntry("ours", {
      [SOURCE_IDENTIFIER_META_KEY]: URL_DROPPED,
      syncConfigId: SYNC_CONFIG_ID,
    });
    const theirs = await insertEntry(
      "theirs",
      {
        [SOURCE_IDENTIFIER_META_KEY]: URL_DROPPED,
        syncConfigId: SYNC_CONFIG_ID,
      },
      TEST_ORGANISATION_2.id
    );

    const result = await deleteOrphanedKnowledgeEntries({
      tenantId: TEST_ORGANISATION_1.id,
      keepSourceIdentifiers: [],
      matchScope: { syncConfigId: SYNC_CONFIG_ID },
    });

    expect(result.deletedIds).toEqual([ours.id]);

    const survivor = await getDb()
      .select({ id: knowledgeEntry.id })
      .from(knowledgeEntry)
      .where(eq(knowledgeEntry.id, theirs.id));
    expect(survivor).toHaveLength(1);
  });
});
