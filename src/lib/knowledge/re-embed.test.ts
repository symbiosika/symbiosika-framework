import { describe, it, expect, beforeAll } from "bun:test";
import {
  findKnowledgeEntriesNeedingReEmbed,
  enqueueReEmbedding,
  reEmbedKnowledgeEntry,
} from "./re-embed";
import { getConfiguredEmbeddingModelId } from "./embedding";
import { getDb } from "../db/db-connection";
import { knowledgeEntry, knowledgeChunks } from "../db/db-schema";
import { initTests, TEST_ORGANISATION_3 } from "../../test/init.test";

// TEST_ORGANISATION_3 keeps this suite isolated from other tests that insert
// chunks into organisation 1.
const TENANT = TEST_ORGANISATION_3.id;

const fakeVector = () => {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
};

const insertEntryWithChunks = async (
  models: string[]
): Promise<string> => {
  const db = getDb();
  const [entry] = await db
    .insert(knowledgeEntry)
    .values({
      tenantId: TENANT,
      name: `Re-Embed Test Entry ${crypto.randomUUID()}`,
    })
    .returning();
  for (const [order, model] of models.entries()) {
    await db.insert(knowledgeChunks).values({
      knowledgeEntryId: entry!.id,
      text: `chunk ${order} of ${entry!.name}`,
      order,
      embeddingModel: model,
      dimensions: 1024,
      textEmbedding1024: fakeVector(),
    });
  }
  return entry!.id;
};

describe("Re-embed after embedding model change", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("finds entries with outdated chunks and enqueues deduped jobs", async () => {
    const currentModel = getConfiguredEmbeddingModelId();
    if (!currentModel) return; // provider not configured in this environment

    // one entry with a single outdated chunk, one entry fully current
    const outdatedEntryId = await insertEntryWithChunks([
      "legacy-model",
      currentModel,
    ]);
    await insertEntryWithChunks([currentModel]);

    const found = await findKnowledgeEntriesNeedingReEmbed(TENANT);
    expect(found.length).toBe(1);
    expect(found[0]!.knowledgeEntryId).toBe(outdatedEntryId);
    expect(found[0]!.outdatedChunks).toBe(1);

    const first = await enqueueReEmbedding(TENANT);
    expect(first).toEqual({ enqueued: 1, outdatedEntries: 1 });

    // a second trigger must not pile up duplicate jobs
    const second = await enqueueReEmbedding(TENANT);
    expect(second).toEqual({ enqueued: 0, outdatedEntries: 1 });
  });

  it("no-ops gracefully when no embedding provider is configured", async () => {
    const previous = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = "__not-configured__";
    try {
      expect(getConfiguredEmbeddingModelId()).toBeNull();
      expect(await findKnowledgeEntriesNeedingReEmbed(TENANT)).toEqual([]);
      expect(
        await reEmbedKnowledgeEntry(crypto.randomUUID(), TENANT)
      ).toEqual({ status: "skipped", chunks: 0 });
    } finally {
      if (previous === undefined) delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = previous;
    }
  });
});
