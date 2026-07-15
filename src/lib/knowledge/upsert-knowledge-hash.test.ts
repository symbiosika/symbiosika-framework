/**
 * DB-backed tests for source hashing in `upsertKnowledgeFromText`.
 *
 * These deliberately exercise only the paths that do NOT call the embedding
 * API: the column round-trip and the "unchanged source → skip re-embed" branch
 * (which returns before any chunk/embedding work). The changed-source path is
 * covered by the pure `isSourceUnchanged` unit tests + the existing sync
 * integration test.
 */

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  initTests,
  TEST_ADMIN_USER,
  TEST_ORGANISATION_1,
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { knowledgeEntry } from "../db/schema/knowledge";
import {
  SOURCE_IDENTIFIER_META_KEY,
  upsertKnowledgeFromText,
} from "./upsert-knowledge";
import { computeSourceHash } from "./source-hash";

const SOURCE_ID = "https://example.com/hash-test-doc";
const TEXT = "Some stable document content used for the hash test.";
const HASH = computeSourceHash(TEXT);
const OLD_TIMESTAMP = "2000-01-01T00:00:00.000Z";

beforeAll(async () => {
  await initTests();
});

const insertHashedEntry = async () => {
  const [row] = await getDb()
    .insert(knowledgeEntry)
    .values({
      tenantId: TEST_ORGANISATION_1.id,
      userId: TEST_ADMIN_USER.id,
      name: "hash-test",
      sourceHash: HASH,
      updatedAt: OLD_TIMESTAMP,
      meta: { [SOURCE_IDENTIFIER_META_KEY]: SOURCE_ID } as never,
    })
    .returning();
  if (!row) throw new Error("Failed to insert test entry");
  return row;
};

const cleanup = async () => {
  await getDb()
    .delete(knowledgeEntry)
    .where(eq(knowledgeEntry.tenantId, TEST_ORGANISATION_1.id));
};

beforeEach(cleanup);

describe("source hashing in upsertKnowledgeFromText", () => {
  test("persists the source hash to the indexed column", async () => {
    const row = await insertHashedEntry();
    const [fetched] = await getDb()
      .select()
      .from(knowledgeEntry)
      .where(eq(knowledgeEntry.id, row.id));
    expect(fetched?.sourceHash).toBe(HASH);
  });

  test("skips re-embedding when the content hash is unchanged", async () => {
    const row = await insertHashedEntry();

    const result = await upsertKnowledgeFromText({
      tenantId: TEST_ORGANISATION_1.id,
      sourceIdentifier: SOURCE_ID,
      title: "hash-test",
      text: TEXT,
      // no explicit sourceHash → derived from TEXT, equals the stored hash
      computeSourceHash: true,
    });

    expect(result).toEqual({
      id: row.id,
      ok: true,
      created: false,
      skipped: true,
    });

    // Only the "last seen" timestamp advanced; the entry was not replaced.
    const [after] = await getDb()
      .select()
      .from(knowledgeEntry)
      .where(eq(knowledgeEntry.id, row.id));
    expect(after?.updatedAt).not.toBe(OLD_TIMESTAMP);
    expect(after?.sourceHash).toBe(HASH);
  });

  test("an explicit matching sourceHash skips even when the text differs", async () => {
    const row = await insertHashedEntry();

    const result = await upsertKnowledgeFromText({
      tenantId: TEST_ORGANISATION_1.id,
      sourceIdentifier: SOURCE_ID,
      title: "hash-test",
      text: "completely different text that would otherwise be re-embedded",
      // caller passes the real file hash, which matches the stored one
      sourceHash: HASH,
    });

    expect(result.skipped).toBe(true);
    expect(result.created).toBe(false);
  });

  test("does not skip when hashing is off (no hash on the incoming side)", async () => {
    // Store an entry WITHOUT a source hash; a non-hashing re-sync must not
    // be able to skip (there is nothing to compare).
    const [row] = await getDb()
      .insert(knowledgeEntry)
      .values({
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ADMIN_USER.id,
        name: "no-hash",
        updatedAt: OLD_TIMESTAMP,
        meta: { [SOURCE_IDENTIFIER_META_KEY]: SOURCE_ID } as never,
      })
      .returning();
    if (!row) throw new Error("insert failed");

    // We assert the *decision* here without running the (embedding-backed)
    // replace path: with hashing off, the skip branch is never taken.
    const { isSourceUnchanged } = await import("./source-hash");
    expect(isSourceUnchanged(row.sourceHash, undefined)).toBe(false);
  });
});
