import { describe, it, expect, beforeAll } from "bun:test";
import { searchKnowledgeTexts } from "./knowledge-text-search";
import { createKnowledgeText } from "./knowledge-texts";
import { syncKnowledgeTextEmbedding } from "./knowledge-text-embedding";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

// unique per test run so searches only hit this run's fixtures
const RUN_TAG = `zqx${crypto.randomUUID().slice(0, 8)}`;

const hasEmbeddingProvider = !!process.env.MISTRAL_API_KEY;

describe("Knowledge Text Search (full-text)", () => {
  beforeAll(async () => {
    await initTests();

    await createKnowledgeText({
      title: `Vacation Policy ${RUN_TAG}`,
      text: `Employees get 30 days of paid vacation per year. Requests go through the HR portal. ${RUN_TAG}`,
      tenantId: ctx.tenantId,
    });
    await createKnowledgeText({
      title: `Home Office Rules ${RUN_TAG}`,
      text: `Working from home is allowed three days per week after approval. ${RUN_TAG}`,
      tenantId: ctx.tenantId,
    });
    await createKnowledgeText({
      title: `Hidden Handbook ${RUN_TAG}`,
      text: `Secret vacation exceptions for admins. ${RUN_TAG}`,
      tenantId: ctx.tenantId,
      hidden: true,
    });
  });

  it("finds pages by content words", async () => {
    const results = await searchKnowledgeTexts(`vacation ${RUN_TAG}`, ctx, {
      mode: "fulltext",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toBe(`Vacation Policy ${RUN_TAG}`);
    expect(results[0]?.matchedBy).toEqual(["fulltext"]);
    expect(results[0]?.snippet.toLowerCase()).toContain("vacation");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it("supports websearch syntax (quoted phrases, exclusion)", async () => {
    const phrase = await searchKnowledgeTexts(
      `"paid vacation" ${RUN_TAG}`,
      ctx,
      { mode: "fulltext" }
    );
    expect(phrase.some((r) => r.title.startsWith("Vacation Policy"))).toBe(
      true
    );

    const excluded = await searchKnowledgeTexts(
      `${RUN_TAG} -vacation`,
      ctx,
      { mode: "fulltext" }
    );
    expect(excluded.some((r) => r.title.startsWith("Vacation Policy"))).toBe(
      false
    );
    expect(excluded.some((r) => r.title.startsWith("Home Office"))).toBe(true);
  });

  it("falls back to substring matching for partial words", async () => {
    // "vacat" is no full token — FTS misses it, the ILIKE fallback catches it
    const results = await searchKnowledgeTexts(`vacat`, ctx, {
      mode: "fulltext",
      limit: 50,
    });
    expect(
      results.some((r) => r.title === `Vacation Policy ${RUN_TAG}`)
    ).toBe(true);
  });

  it("excludes hidden pages by default and includes them on request", async () => {
    const withoutHidden = await searchKnowledgeTexts(
      `vacation ${RUN_TAG}`,
      ctx,
      { mode: "fulltext", limit: 50 }
    );
    expect(
      withoutHidden.some((r) => r.title.startsWith("Hidden Handbook"))
    ).toBe(false);

    const withHidden = await searchKnowledgeTexts(
      `vacation ${RUN_TAG}`,
      { ...ctx, includeHidden: true },
      { mode: "fulltext", limit: 50 }
    );
    expect(
      withHidden.some((r) => r.title.startsWith("Hidden Handbook"))
    ).toBe(true);
  });

  it("returns [] for an empty query", async () => {
    expect(await searchKnowledgeTexts("   ", ctx)).toEqual([]);
  });

  it("hybrid mode works without an embedding provider (degrades to fulltext)", async () => {
    const results = await searchKnowledgeTexts(`vacation ${RUN_TAG}`, ctx, {
      mode: "hybrid",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toBe(`Vacation Policy ${RUN_TAG}`);
  });

  it("respects the limit", async () => {
    const results = await searchKnowledgeTexts(RUN_TAG, ctx, {
      mode: "fulltext",
      limit: 1,
    });
    expect(results.length).toBe(1);
  });
});

describe.skipIf(!hasEmbeddingProvider)(
  "Knowledge Text Search (hybrid with embeddings, needs MISTRAL_API_KEY)",
  () => {
    beforeAll(async () => {
      await initTests();

      const page = await createKnowledgeText({
        title: `Team Events ${RUN_TAG}`,
        text: `Every quarter we organize a company offsite with workshops and social activities. ${RUN_TAG}`,
        tenantId: ctx.tenantId,
        embeddingEnabled: true,
      });
      await syncKnowledgeTextEmbedding(page.id, ctx.tenantId);
    });

    it("finds semantically similar pages without exact word overlap", async () => {
      // "celebration gathering" shares no token with the page text
      const results = await searchKnowledgeTexts(
        "quarterly celebration gathering colleagues",
        ctx,
        { mode: "semantic", limit: 20 }
      );
      expect(
        results.some((r) => r.title === `Team Events ${RUN_TAG}`)
      ).toBe(true);
      expect(results[0]?.matchedBy).toContain("semantic");
    }, 30000);

    it("hybrid fuses both legs and flags pages found by both", async () => {
      const results = await searchKnowledgeTexts(
        `offsite workshops ${RUN_TAG}`,
        ctx,
        { mode: "hybrid", limit: 20 }
      );
      const hit = results.find((r) => r.title === `Team Events ${RUN_TAG}`);
      expect(hit).toBeDefined();
      expect(hit?.matchedBy).toContain("fulltext");
      expect(hit?.matchedBy).toContain("semantic");
    }, 30000);
  }
);
