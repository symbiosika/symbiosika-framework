import { describe, it, expect, beforeAll } from "bun:test";
import {
  upsertKnowledgeTextFromSource,
  deleteOrphanedKnowledgeTexts,
  findKnowledgeTextBySourceIdentifier,
} from "./knowledge-text-sync";
import {
  createKnowledgeText,
  getKnowledgeTextById,
  getKnowledgeTextHistory,
} from "./knowledge-texts";
import {
  syncKnowledgeTextBlocks,
  getKnowledgeTextBlocks,
} from "./knowledge-text-blocks";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

// per-run scope so parallel/repeated runs don't interfere
const SCOPE = { syncConfigId: crypto.randomUUID() };

describe("Knowledge Text Sync", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("creates a page on first sync with the identifier in meta", async () => {
    const result = await upsertKnowledgeTextFromSource({
      tenantId: ctx.tenantId,
      sourceIdentifier: "https://example.com/doc-1",
      title: "Synced Doc 1",
      text: "external content v1",
      matchScope: SCOPE,
    });

    expect(result.created).toBe(true);
    expect(result.changed).toBe(true);

    const page = await getKnowledgeTextById(result.id, ctx);
    expect(page.title).toBe("Synced Doc 1");
    expect((page.meta as any).sourceIdentifier).toBe(
      "https://example.com/doc-1"
    );
    expect((page.meta as any).syncConfigId).toBe(SCOPE.syncConfigId);
  });

  it("is a no-op when the content is unchanged", async () => {
    const input = {
      tenantId: ctx.tenantId,
      sourceIdentifier: "https://example.com/doc-2",
      title: "Synced Doc 2",
      text: "stable content",
      matchScope: SCOPE,
    };
    const first = await upsertKnowledgeTextFromSource(input);
    const historyBefore = (await getKnowledgeTextHistory(first.id, ctx)).length;

    const second = await upsertKnowledgeTextFromSource(input);
    expect(second.created).toBe(false);
    expect(second.changed).toBe(false);
    expect(second.id).toBe(first.id);

    const historyAfter = (await getKnowledgeTextHistory(first.id, ctx)).length;
    expect(historyAfter).toBe(historyBefore);
  });

  it("updates in place when the content changed, keeping the page id", async () => {
    const base = {
      tenantId: ctx.tenantId,
      sourceIdentifier: "https://example.com/doc-3",
      title: "Synced Doc 3",
      text: "version 1",
      matchScope: SCOPE,
    };
    const first = await upsertKnowledgeTextFromSource(base);

    const second = await upsertKnowledgeTextFromSource({
      ...base,
      title: "Synced Doc 3 (renamed)",
      text: "version 2",
    });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(second.changed).toBe(true);

    const page = await getKnowledgeTextById(first.id, ctx);
    expect(page.title).toBe("Synced Doc 3 (renamed)");
    expect(page.text).toBe("version 2");
  });

  it("replaces the blocks of a block-mode page on update", async () => {
    const base = {
      tenantId: ctx.tenantId,
      sourceIdentifier: "https://example.com/doc-4",
      title: "Synced Doc 4",
      text: "initial",
      matchScope: SCOPE,
    };
    const first = await upsertKnowledgeTextFromSource(base);

    // someone converted the synced page to block mode in the meantime
    await syncKnowledgeTextBlocks(
      first.id,
      [
        { type: "markdown", content: "locally edited A" },
        { type: "markdown", content: "locally edited B" },
      ],
      ctx
    );

    await upsertKnowledgeTextFromSource({ ...base, text: "fresh from source" });

    const blocks = await getKnowledgeTextBlocks(first.id, ctx);
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.content).toBe("fresh from source");
    const page = await getKnowledgeTextById(first.id, ctx);
    expect(page.text).toBe("fresh from source");
  });

  it("finds pages only within the matchScope", async () => {
    const otherScope = { syncConfigId: crypto.randomUUID() };
    await upsertKnowledgeTextFromSource({
      tenantId: ctx.tenantId,
      sourceIdentifier: "shared-id",
      title: "Scope A Page",
      text: "a",
      matchScope: SCOPE,
    });
    const inOtherScope = await findKnowledgeTextBySourceIdentifier(
      ctx.tenantId,
      "shared-id",
      otherScope
    );
    expect(inOtherScope).toBeNull();

    // same identifier in another scope creates a SEPARATE page
    const result = await upsertKnowledgeTextFromSource({
      tenantId: ctx.tenantId,
      sourceIdentifier: "shared-id",
      title: "Scope B Page",
      text: "b",
      matchScope: otherScope,
    });
    expect(result.created).toBe(true);
  });

  it("deletes orphaned synced pages but never hand-written ones", async () => {
    const scope = { syncConfigId: crypto.randomUUID() };
    const keep = await upsertKnowledgeTextFromSource({
      tenantId: ctx.tenantId,
      sourceIdentifier: "keep-me",
      title: "Keep Page",
      text: "keep",
      matchScope: scope,
    });
    const orphan = await upsertKnowledgeTextFromSource({
      tenantId: ctx.tenantId,
      sourceIdentifier: "remove-me",
      title: "Orphan Page",
      text: "orphan",
      matchScope: scope,
    });
    // a hand-written page (no sourceIdentifier) with the same scope-ish meta
    const manual = await createKnowledgeText({
      tenantId: ctx.tenantId,
      title: `Manual Page ${crypto.randomUUID()}`,
      text: "hand-written",
      meta: { syncConfigId: scope.syncConfigId },
    });

    const cleanup = await deleteOrphanedKnowledgeTexts({
      tenantId: ctx.tenantId,
      activeSourceIdentifiers: ["keep-me"],
      matchScope: scope,
    });

    expect(cleanup.deleted).toBe(1);
    await expect(getKnowledgeTextById(orphan.id, ctx)).rejects.toThrow();
    // kept + manual pages survive
    const keptPage = await getKnowledgeTextById(keep.id, ctx);
    expect(keptPage.title).toBe("Keep Page");
    const manualPage = await getKnowledgeTextById(manual.id, ctx);
    expect(manualPage.text).toBe("hand-written");
  });

  it("does not touch synced pages outside the matchScope during cleanup", async () => {
    const scopeA = { syncConfigId: crypto.randomUUID() };
    const scopeB = { syncConfigId: crypto.randomUUID() };
    const pageB = await upsertKnowledgeTextFromSource({
      tenantId: ctx.tenantId,
      sourceIdentifier: "other-scope-page",
      title: "Other Scope Page",
      text: "b",
      matchScope: scopeB,
    });

    // cleanup in scope A with an empty keep-set must not delete scope B pages
    await deleteOrphanedKnowledgeTexts({
      tenantId: ctx.tenantId,
      activeSourceIdentifiers: [],
      matchScope: scopeA,
    });

    const survived = await getKnowledgeTextById(pageB.id, ctx);
    expect(survived.title).toBe("Other Scope Page");
  });
});
