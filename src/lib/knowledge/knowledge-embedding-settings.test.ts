import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  KNOWLEDGE_EMBEDDING_SETTING_KEY,
  getEmbeddingProviderStatus,
  getKnowledgeEmbeddingSettings,
  getTenantEmbeddingEnabled,
  setTenantEmbeddingEnabled,
} from "./knowledge-embedding-settings";
import {
  createKnowledgeText,
  getKnowledgeTextById,
  updateKnowledgeText,
} from "./knowledge-texts";
import { getDb } from "../db/db-connection";
import { tenantSettings } from "../db/schema/tenant-settings";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORGANISATION_2,
} from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

const createPage = (overrides?: Record<string, unknown>) =>
  createKnowledgeText({
    title: `Embedding Setting Page ${crypto.randomUUID()}`,
    text: "content",
    tenantId: ctx.tenantId,
    ...overrides,
  });

describe("Organisation-wide embedding setting", () => {
  beforeAll(async () => {
    await initTests();
    await setTenantEmbeddingEnabled(ctx.tenantId, false);
  });

  afterAll(async () => {
    await setTenantEmbeddingEnabled(ctx.tenantId, false);
  });

  it("defaults to disabled when nothing was ever stored", async () => {
    await getDb()
      .delete(tenantSettings)
      .where(
        and(
          eq(tenantSettings.tenantId, TEST_ORGANISATION_2.id),
          eq(tenantSettings.key, KNOWLEDGE_EMBEDDING_SETTING_KEY)
        )
      );
    expect(await getTenantEmbeddingEnabled(TEST_ORGANISATION_2.id)).toBe(false);
  });

  it("stores the switch and reports the provider status", async () => {
    await setTenantEmbeddingEnabled(ctx.tenantId, true);
    const state = await getKnowledgeEmbeddingSettings(ctx.tenantId);
    expect(state.enabled).toBe(true);
    expect(state.provider.provider).toBeDefined();
    // configured only when the provider's API key is present in this env
    expect(state.provider.configured).toBe(
      getEmbeddingProviderStatus().configured
    );
    if (!state.provider.configured) {
      expect(state.provider.model).toBeNull();
      expect(state.provider.requiredEnvVar).toBeTruthy();
    }
    await setTenantEmbeddingEnabled(ctx.tenantId, false);
  });

  it("is scoped to one organisation", async () => {
    await setTenantEmbeddingEnabled(ctx.tenantId, true);
    expect(await getTenantEmbeddingEnabled(TEST_ORGANISATION_2.id)).toBe(false);
    await setTenantEmbeddingEnabled(ctx.tenantId, false);
  });

  it("flips the derived flag on existing pages in both directions", async () => {
    const page = await createPage();
    expect(page.embeddingEnabled).toBe(false);

    const on = await setTenantEmbeddingEnabled(ctx.tenantId, true);
    expect(on.pagesUpdated).toBeGreaterThan(0);
    expect((await getKnowledgeTextById(page.id, ctx)).embeddingEnabled).toBe(
      true
    );

    await setTenantEmbeddingEnabled(ctx.tenantId, false);
    expect((await getKnowledgeTextById(page.id, ctx)).embeddingEnabled).toBe(
      false
    );
  });

  it("applies to newly created pages while it is on", async () => {
    await setTenantEmbeddingEnabled(ctx.tenantId, true);
    try {
      const page = await createPage();
      expect(page.embeddingEnabled).toBe(true);
    } finally {
      await setTenantEmbeddingEnabled(ctx.tenantId, false);
    }
    // the create triggers a real embedding sync when a provider is configured
  }, 30000);

  it("cannot be overridden per page by a request body", async () => {
    const page = await createPage({ embeddingEnabled: true });
    expect(page.embeddingEnabled).toBe(false);

    const updated = await updateKnowledgeText(
      page.id,
      { embeddingEnabled: true, title: `${page.title} (edited)` },
      ctx
    );
    expect(updated.embeddingEnabled).toBe(false);
  }, 30000);
});
