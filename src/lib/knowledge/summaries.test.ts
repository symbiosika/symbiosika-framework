import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { initTests } from "../../test/init.test";
import { TEST_ORGANISATION_1 } from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import { jobs } from "../db/schema/jobs";
import {
  createKnowledgeText,
  updateKnowledgeText,
  getKnowledgeTextById,
} from "./knowledge-texts";
import {
  buildSummaryInput,
  computeSummaryContentHash,
  processSummaryForPage,
  sweepStaleSummaries,
  enqueueSummaryBackfill,
  SUMMARY_JOB_TYPE,
} from "./summaries";
import { setServerSetting, SERVER_SETTING_KEYS } from "../server-settings";

const TENANT = TEST_ORGANISATION_1.id;

const AI_ENV = {
  AI_PROVIDER: process.env.AI_PROVIDER,
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
};
const enableFakeAi = () => {
  process.env.AI_PROVIDER = "mistral";
  process.env.MISTRAL_API_KEY = "sk-fake-for-config-only";
};
const disableAi = () => {
  delete process.env.AI_PROVIDER;
};

afterEach(() => {
  process.env.AI_PROVIDER = AI_ENV.AI_PROVIDER;
  process.env.MISTRAL_API_KEY = AI_ENV.MISTRAL_API_KEY;
});

describe("B1 page summaries", () => {
  beforeAll(async () => {
    await initTests();
  });

  describe("pure helpers", () => {
    test("computeSummaryContentHash is stable and content-sensitive", () => {
      const a = computeSummaryContentHash("Title", "Body");
      const b = computeSummaryContentHash("Title", "Body");
      const c = computeSummaryContentHash("Title", "Body changed");
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    test("buildSummaryInput passes short content through in full", () => {
      const out = buildSummaryInput("My Page", "Short body");
      expect(out).toContain("My Page");
      expect(out).toContain("Short body");
    });

    test("buildSummaryInput compresses long content under the budget", () => {
      const long =
        "# Intro\n" +
        "x".repeat(30_000) +
        "\n## Section A\nLead A line\nmore\n## Section B\nLead B line\n";
      const out = buildSummaryInput("Big Page", long);
      expect(out.length).toBeLessThanOrEqual(8_000);
      expect(out).toContain("Big Page");
      // outline should capture the headings
      expect(out).toContain("## Section A");
      expect(out).toContain("## Section B");
    });
  });

  describe("stale flag on write", () => {
    test("creating a page with content marks the summary stale", async () => {
      const page = await createKnowledgeText({
        tenantId: TENANT,
        title: "Stale on create",
        text: "Some content here",
      });
      const fetched = await getKnowledgeTextById(page.id, { tenantId: TENANT });
      expect(fetched.summaryStale).toBe(true);
      expect(fetched.summaryMode).toBe("auto");
      expect(fetched.summary).toBeNull();
    });

    test("creating an empty page does not mark it stale", async () => {
      const page = await createKnowledgeText({
        tenantId: TENANT,
        title: "Empty page",
        text: "",
      });
      const fetched = await getKnowledgeTextById(page.id, { tenantId: TENANT });
      expect(fetched.summaryStale).toBe(false);
    });

    test("a manual summary provided on create is kept and not marked stale", async () => {
      const page = await createKnowledgeText({
        tenantId: TENANT,
        title: "Manual create",
        text: "content",
        summaryMode: "manual",
        summary: "A hand-written summary.",
      });
      const fetched = await getKnowledgeTextById(page.id, { tenantId: TENANT });
      expect(fetched.summary).toBe("A hand-written summary.");
      expect(fetched.summaryStale).toBe(false);
    });

    test("editing content marks an existing page stale again", async () => {
      const page = await createKnowledgeText({
        tenantId: TENANT,
        title: "Edit me",
        text: "v1",
      });
      // clear the stale flag to simulate an already-generated summary
      await getDb()
        .update(knowledgeText)
        .set({ summaryStale: false })
        .where(eq(knowledgeText.id, page.id));

      await updateKnowledgeText(page.id, { text: "v2 content" }, {
        tenantId: TENANT,
      });
      const fetched = await getKnowledgeTextById(page.id, { tenantId: TENANT });
      expect(fetched.summaryStale).toBe(true);
    });
  });

  describe("processSummaryForPage gating", () => {
    test("skips (no LLM call) when AI is disabled", async () => {
      disableAi();
      const page = await createKnowledgeText({
        tenantId: TENANT,
        title: "No AI page",
        text: "content",
      });
      const res = await processSummaryForPage(page.id, TENANT);
      expect(res.status).toBe("skipped");
    });

    test("skips manual pages and clears their stale flag", async () => {
      enableFakeAi();
      const page = await createKnowledgeText({
        tenantId: TENANT,
        title: "Manual mode",
        text: "content",
        summaryMode: "manual",
      });
      // force stale to verify it gets cleared
      await getDb()
        .update(knowledgeText)
        .set({ summaryStale: true })
        .where(eq(knowledgeText.id, page.id));

      const res = await processSummaryForPage(page.id, TENANT);
      expect(res.status).toBe("skipped");
      const fetched = await getKnowledgeTextById(page.id, { tenantId: TENANT });
      expect(fetched.summaryStale).toBe(false);
    });

    test("returns 'unchanged' (no LLM) when the content hash matches", async () => {
      enableFakeAi();
      const page = await createKnowledgeText({
        tenantId: TENANT,
        title: "Unchanged page",
        text: "stable content",
      });
      const hash = computeSummaryContentHash(
        "Unchanged page",
        "stable content"
      );
      await getDb()
        .update(knowledgeText)
        .set({ summaryContentHash: hash, summaryStale: true })
        .where(eq(knowledgeText.id, page.id));

      const res = await processSummaryForPage(page.id, TENANT);
      expect(res.status).toBe("unchanged");
      const fetched = await getKnowledgeTextById(page.id, { tenantId: TENANT });
      expect(fetched.summaryStale).toBe(false);
    });
  });

  describe("sweeper + backfill", () => {
    test("sweeper is a no-op when AI is disabled", async () => {
      disableAi();
      const res = await sweepStaleSummaries();
      expect(res.enqueued).toBe(0);
    });

    test("sweeper enqueues a job for a stale, quiet page (debounce=0)", async () => {
      enableFakeAi();
      await setServerSetting(
        SERVER_SETTING_KEYS.WIKI_SUMMARY_DEBOUNCE_MINUTES,
        "0"
      );
      const page = await createKnowledgeText({
        tenantId: TENANT,
        title: "Sweep me",
        text: "content to summarize",
      });
      // ensure stale
      await getDb()
        .update(knowledgeText)
        .set({ summaryStale: true })
        .where(eq(knowledgeText.id, page.id));

      const res = await sweepStaleSummaries();
      expect(res.enqueued).toBeGreaterThanOrEqual(1);

      const enqueued = await getDb()
        .select()
        .from(jobs)
        .where(eq(jobs.type, SUMMARY_JOB_TYPE));
      const forPage = enqueued.filter(
        (j) => (j.metadata as { pageId?: string })?.pageId === page.id
      );
      expect(forPage.length).toBe(1);

      // running the sweep again must not double-enqueue (dedup on pending jobs)
      const res2 = await sweepStaleSummaries();
      const enqueued2 = await getDb()
        .select()
        .from(jobs)
        .where(eq(jobs.type, SUMMARY_JOB_TYPE));
      const forPage2 = enqueued2.filter(
        (j) => (j.metadata as { pageId?: string })?.pageId === page.id
      );
      expect(forPage2.length).toBe(1);
    });

    test("backfill flags auto pages that have no summary", async () => {
      const before = await enqueueSummaryBackfill(TENANT);
      // at least the pages created above without a summary get flagged
      expect(before.flagged).toBeGreaterThanOrEqual(1);
    });
  });
});
