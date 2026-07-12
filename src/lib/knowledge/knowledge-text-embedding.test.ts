import { describe, it, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import {
  syncKnowledgeTextEmbedding,
  syncKnowledgeTextEmbeddingSafe,
  knowledgeTextSourceIdentifier,
} from "./knowledge-text-embedding";
import {
  createKnowledgeText,
  getKnowledgeTextById,
  updateKnowledgeText,
  deleteKnowledgeText,
} from "./knowledge-texts";
import { syncKnowledgeTextBlocks } from "./knowledge-text-blocks";
import { getDb } from "../db/db-connection";
import { knowledgeEntry, knowledgeChunks } from "../db/schema/knowledge";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

// The full sync path needs a real embedding provider (same pattern as
// add-knowledge.test.ts, which runs in CI where MISTRAL_API_KEY is set)
const hasEmbeddingProvider = !!process.env.MISTRAL_API_KEY;

const createPage = async (overrides?: Record<string, unknown>) =>
  await createKnowledgeText({
    text: "",
    title: `Embedding Test Page ${crypto.randomUUID()}`,
    tenantId: TEST_ORGANISATION_1.id,
    ...overrides,
  });

describe("Knowledge Text Embedding (no provider required)", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("does nothing for a page with embedding disabled", async () => {
    const page = await createPage({ text: "some content" });
    const result = await syncKnowledgeTextEmbedding(page.id, ctx.tenantId);
    expect(result.synced).toBe(false);
    expect(result.removed).toBe(false);
    expect(result.knowledgeEntryId).toBeNull();
  });

  it("does nothing for an enabled page with empty text", async () => {
    const page = await createPage({ text: "", embeddingEnabled: true });
    const result = await syncKnowledgeTextEmbedding(page.id, ctx.tenantId);
    expect(result.synced).toBe(false);
    expect(result.removed).toBe(false);
  });

  it("throws for an unknown page and the safe variant swallows it", async () => {
    const unknownId = crypto.randomUUID();
    await expect(
      syncKnowledgeTextEmbedding(unknownId, ctx.tenantId)
    ).rejects.toThrow();
    const safe = await syncKnowledgeTextEmbeddingSafe(unknownId, ctx.tenantId);
    expect(safe).toBeNull();
  });

  it("block saves on a page without embedding do not fail", async () => {
    const page = await createPage();
    const result = await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: "no embedding here" }],
      ctx
    );
    expect(result.knowledgeText.knowledgeEntryId).toBeNull();
  });

  it("builds a stable source identifier", () => {
    expect(knowledgeTextSourceIdentifier("abc")).toBe("knowledge-text:abc");
  });

  it("creating an embedding-enabled page never fails, with or without a provider", async () => {
    // the initial sync on create is best-effort: without a provider it
    // logs and the page is still created; with a provider (CI) it embeds
    const page = await createPage({
      text: "content that would be embedded",
      embeddingEnabled: true,
    });
    expect(page.id).toBeDefined();
    if (hasEmbeddingProvider) {
      expect(page.knowledgeEntryId).not.toBeNull();
    } else {
      expect(page.knowledgeEntryId).toBeNull();
    }
  });
});

describe.skipIf(!hasEmbeddingProvider)(
  "Knowledge Text Embedding (full sync, needs MISTRAL_API_KEY)",
  () => {
    beforeAll(async () => {
      await initTests();
    });

    it("embeds a page directly on create when embeddingEnabled is set", async () => {
      const page = await createPage({
        text: "Pages created with embedding on are synced immediately.",
        embeddingEnabled: true,
      });
      // create already ran the initial sync
      expect(page.knowledgeEntryId).toBeDefined();
      expect(page.knowledgeEntryId).not.toBeNull();
    }, 30000);

    it("creates a knowledge entry on first sync and links it", async () => {
      const page = await createPage({
        text: "This wiki page explains our vacation policy in detail.",
        embeddingEnabled: false,
      });
      await updateKnowledgeText(page.id, { embeddingEnabled: true }, ctx);

      const result = await syncKnowledgeTextEmbedding(page.id, ctx.tenantId);
      expect(result.knowledgeEntryId).toBeDefined();

      const fresh = await getKnowledgeTextById(page.id, ctx);
      expect(fresh.knowledgeEntryId).toBe(result.knowledgeEntryId!);
      expect((fresh.meta as any).embeddingContentHash).toBeDefined();

      // chunks exist for the entry
      const chunks = await getDb()
        .select()
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.knowledgeEntryId, result.knowledgeEntryId!));
      expect(chunks.length).toBeGreaterThan(0);
    }, 30000);

    it("skips unchanged content and re-syncs in place on change", async () => {
      // create already runs the initial sync (embeddingEnabled is set)
      const page = await createPage({
        text: "Original content for the change detection test.",
        embeddingEnabled: true,
      });
      expect(page.knowledgeEntryId).not.toBeNull();
      const entryId = page.knowledgeEntryId!;

      // same content again → skipped
      const second = await syncKnowledgeTextEmbedding(page.id, ctx.tenantId);
      expect(second.unchanged).toBe(true);
      expect(second.synced).toBe(false);
      expect(second.knowledgeEntryId).toBe(entryId);

      // block save changes the text → re-sync replaces the SAME entry
      await syncKnowledgeTextBlocks(
        page.id,
        [{ type: "markdown", content: "Completely new content." }],
        ctx
      );
      const fresh = await getKnowledgeTextById(page.id, ctx);
      expect(fresh.knowledgeEntryId).toBe(entryId);

      const chunks = await getDb()
        .select()
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.knowledgeEntryId, entryId));
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]?.text).toContain("Completely new content");
    }, 60000);

    it("removes the entry when embedding is disabled", async () => {
      // create already runs the initial sync (embeddingEnabled is set)
      const page = await createPage({
        text: "Content that will be un-embedded.",
        embeddingEnabled: true,
      });
      expect(page.knowledgeEntryId).not.toBeNull();
      const entryId = page.knowledgeEntryId!;

      await updateKnowledgeText(
        page.id,
        { embeddingEnabled: false },
        ctx
      );

      const fresh = await getKnowledgeTextById(page.id, ctx);
      expect(fresh.knowledgeEntryId).toBeNull();

      const entries = await getDb()
        .select()
        .from(knowledgeEntry)
        .where(eq(knowledgeEntry.id, entryId));
      expect(entries.length).toBe(0);
    }, 30000);

    it("removes the entry when the page is deleted", async () => {
      // create already runs the initial sync (embeddingEnabled is set)
      const page = await createPage({
        text: "Content of a page that will be deleted.",
        embeddingEnabled: true,
      });
      expect(page.knowledgeEntryId).not.toBeNull();
      const entryId = page.knowledgeEntryId!;

      await deleteKnowledgeText(page.id, ctx);

      const entries = await getDb()
        .select()
        .from(knowledgeEntry)
        .where(eq(knowledgeEntry.id, entryId));
      expect(entries.length).toBe(0);
    }, 30000);
  }
);
