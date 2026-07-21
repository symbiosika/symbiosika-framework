import { describe, test, expect, beforeAll } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { knowledgeEntry, knowledgeChunks } from "../db/schema/knowledge";
import { createKnowledgeText, updateKnowledgeText } from "./knowledge-texts";
import { getPageChunkContext } from "./knowledge-text-chunks";

const TENANT = TEST_ORGANISATION_1.id;
const ctx = { tenantId: TENANT };

describe("getPageChunkContext", () => {
  let pageId: string;

  beforeAll(async () => {
    await initTests();

    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: "Chunk context page",
      text: "irrelevant body",
    });
    pageId = page.id;

    const [entry] = await getDb()
      .insert(knowledgeEntry)
      .values({ tenantId: TENANT, name: "Chunk context entry" })
      .returning();

    // 5 Chunks, order 0..4, Dummy-Vektor erfüllt den CHECK-Constraint
    const vec = new Array(1024).fill(0);
    await getDb()
      .insert(knowledgeChunks)
      .values(
        [0, 1, 2, 3, 4].map((order) => ({
          knowledgeEntryId: entry.id,
          text: `chunk-${order}`,
          order,
          embeddingModel: "test",
          dimensions: 1024,
          textEmbedding1024: vec,
          meta: { page: order + 1 },
        }))
      );

    // Seite mit dem knowledge_entry verknüpfen
    await updateKnowledgeText(pageId, { knowledgeEntryId: entry.id }, ctx);
  });

  test("liefert den Treffer plus Nachbarn davor/danach in order-Reihenfolge", async () => {
    const r = await getPageChunkContext(pageId, ctx, {
      order: 2,
      before: 1,
      after: 1,
    });
    expect(r.knowledgeEntryId).not.toBeNull();
    expect(r.totalChunks).toBe(5);
    expect(r.chunks.map((c) => c.order)).toEqual([1, 2, 3]);
    expect(r.chunks.find((c) => c.matched)?.order).toBe(2);
    expect(r.chunks.find((c) => c.order === 2)?.sourcePage).toBe(3);
  });

  test("klemmt am Anfang sauber ab (order 0)", async () => {
    const r = await getPageChunkContext(pageId, ctx, {
      order: 0,
      before: 2,
      after: 2,
    });
    expect(r.chunks.map((c) => c.order)).toEqual([0, 1, 2]);
  });

  test("Seite ohne Embeddings -> knowledgeEntryId null, keine Chunks", async () => {
    const plain = await createKnowledgeText({
      tenantId: TENANT,
      title: "No embeddings page",
      text: "body",
    });
    const r = await getPageChunkContext(plain.id, ctx, { order: 0 });
    expect(r.knowledgeEntryId).toBeNull();
    expect(r.chunks).toEqual([]);
  });
});
