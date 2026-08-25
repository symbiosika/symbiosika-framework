import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  TEXT_EMBEDDING_JOB_TYPE,
  countKnowledgeTextsNeedingEmbedding,
  enqueueKnowledgeTextEmbeddingBackfill,
  findKnowledgeTextsNeedingEmbedding,
} from "./knowledge-text-embedding-backfill";
import { setTenantEmbeddingEnabled } from "./knowledge-embedding-settings";
import { createKnowledgeText } from "./knowledge-texts";
import { getDb } from "../db/db-connection";
import { jobs } from "../db/schema/jobs";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

/** Drop the backfill jobs of the test tenant so counts stay predictable. */
const clearJobs = async () =>
  getDb()
    .delete(jobs)
    .where(
      and(eq(jobs.type, TEXT_EMBEDDING_JOB_TYPE), eq(jobs.tenantId, ctx.tenantId))
    );

describe("Embedding backfill", () => {
  beforeAll(async () => {
    await initTests();
    await setTenantEmbeddingEnabled(ctx.tenantId, false);
    await clearJobs();
  });

  afterAll(async () => {
    await setTenantEmbeddingEnabled(ctx.tenantId, false);
    await clearJobs();
  });

  it("finds nothing while the organisation switch is off", async () => {
    await createKnowledgeText({
      title: `Backfill Off ${crypto.randomUUID()}`,
      text: "content",
      tenantId: ctx.tenantId,
    });
    expect(await countKnowledgeTextsNeedingEmbedding(ctx.tenantId)).toBe(0);
  });

  it("ignores marked pages without content", async () => {
    await setTenantEmbeddingEnabled(ctx.tenantId, true);
    try {
      const empty = await createKnowledgeText({
        title: `Backfill Empty ${crypto.randomUUID()}`,
        text: "   ",
        tenantId: ctx.tenantId,
      });
      const pending = await findKnowledgeTextsNeedingEmbedding(ctx.tenantId);
      expect(pending).not.toContain(empty.id);
    } finally {
      await setTenantEmbeddingEnabled(ctx.tenantId, false);
    }
  }, 30000);

  it("enqueues one job per pending page and dedupes on a second run", async () => {
    await setTenantEmbeddingEnabled(ctx.tenantId, false);
    // pages created while the switch is off have no mirror ...
    const pages = [];
    for (const i of [1, 2, 3]) {
      pages.push(
        await createKnowledgeText({
          title: `Backfill Page ${i} ${crypto.randomUUID()}`,
          text: `content of page ${i}`,
          tenantId: ctx.tenantId,
        })
      );
    }
    // ... and switching on only MARKS them, it does not embed them
    await setTenantEmbeddingEnabled(ctx.tenantId, true);
    await clearJobs();

    try {
      const pending = await findKnowledgeTextsNeedingEmbedding(ctx.tenantId);
      for (const page of pages) {
        expect(pending).toContain(page.id);
      }

      const first = await enqueueKnowledgeTextEmbeddingBackfill(ctx.tenantId);
      expect(first.enqueued).toBe(first.pendingPages);
      expect(first.enqueued).toBeGreaterThanOrEqual(pages.length);
      expect(first.alreadyQueued).toBe(0);

      const created = await getDb()
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, TEXT_EMBEDDING_JOB_TYPE),
            eq(jobs.tenantId, ctx.tenantId),
            inArray(jobs.status, ["pending", "running"])
          )
        );
      expect(created.length).toBe(first.enqueued);

      // second run: everything is already queued → no duplicates
      const second = await enqueueKnowledgeTextEmbeddingBackfill(ctx.tenantId);
      expect(second.enqueued).toBe(0);
      expect(second.alreadyQueued).toBe(second.pendingPages);
    } finally {
      await setTenantEmbeddingEnabled(ctx.tenantId, false);
      await clearJobs();
    }
  }, 30000);
});
