import { describe, test, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import { createKnowledgeText } from "./knowledge-texts";
import { searchKnowledgeTexts } from "./knowledge-text-search";
import { getPageOutline, readPageSection } from "./knowledge-text-sections";

const TENANT = TEST_ORGANISATION_1.id;
const ctx = { tenantId: TENANT };
// distinctive token so results don't collide with other seeded pages
const TOKEN = "zylophonqx";

describe("enriched wiki search", () => {
  beforeAll(async () => {
    await initTests();
  });

  test("results are enriched with summary, facets and updatedAt", async () => {
    await createKnowledgeText({
      tenantId: TENANT,
      title: `Enriched ${TOKEN} page`,
      text: `Body mentioning ${TOKEN} once.`,
      pageType: "anleitung",
      status: "entwurf",
      summary: "A test summary.",
    });
    const results = await searchKnowledgeTexts(TOKEN, ctx, { mode: "fulltext" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const r = results[0];
    expect(r).toHaveProperty("summary");
    expect(r).toHaveProperty("pageType");
    expect(r).toHaveProperty("status");
    expect(r).toHaveProperty("updatedAt");
    expect(r).toHaveProperty("snippet");
  });

  test("facet filter narrows the results", async () => {
    const tok = TOKEN + "facet";
    await createKnowledgeText({
      tenantId: TENANT,
      title: `Facet A ${tok}`,
      text: `text ${tok}`,
      pageType: "anleitung",
    });
    await createKnowledgeText({
      tenantId: TENANT,
      title: `Facet B ${tok}`,
      text: `text ${tok}`,
      pageType: "policy",
    });
    const onlyPolicy = await searchKnowledgeTexts(tok, ctx, {
      mode: "fulltext",
      filters: { pageType: "policy" },
    });
    expect(onlyPolicy.length).toBeGreaterThanOrEqual(1);
    expect(onlyPolicy.every((r) => r.pageType === "policy")).toBe(true);
  });

  test("verified pages rank above drafts for a comparable match", async () => {
    const tok = TOKEN + "rank";
    await createKnowledgeText({
      tenantId: TENANT,
      title: `Draft ${tok}`,
      text: `content ${tok}`,
      status: "entwurf",
    });
    await createKnowledgeText({
      tenantId: TENANT,
      title: `Verified ${tok}`,
      text: `content ${tok}`,
      status: "verifiziert",
    });
    const results = await searchKnowledgeTexts(tok, ctx, { mode: "fulltext" });
    const verifiedIdx = results.findIndex((r) => r.status === "verifiziert");
    const draftIdx = results.findIndex((r) => r.status === "entwurf");
    expect(verifiedIdx).toBeGreaterThanOrEqual(0);
    expect(draftIdx).toBeGreaterThanOrEqual(0);
    expect(verifiedIdx).toBeLessThan(draftIdx);
  });

  test("a superseded page is folded under its successor", async () => {
    const tok = TOKEN + "supersede";
    const old = await createKnowledgeText({
      tenantId: TENANT,
      title: `Old ${tok}`,
      text: `guide ${tok}`,
      status: "veraltet",
    });
    const fresh = await createKnowledgeText({
      tenantId: TENANT,
      title: `New ${tok}`,
      text: `guide ${tok}`,
      status: "verifiziert",
      supersedesId: old.id,
    });
    const results = await searchKnowledgeTexts(tok, ctx, { mode: "fulltext" });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(old.id); // folded away as an alternative
    const successor = results.find((r) => r.id === fresh.id);
    expect(successor?.supersededAlternatives?.some((a) => a.id === old.id)).toBe(
      true
    );
  });

  describe("heading addressing", () => {
    let pageId: string;
    beforeAll(async () => {
      const page = await createKnowledgeText({
        tenantId: TENANT,
        title: "Sectioned page",
        text: [
          "# Intro",
          "Welcome text.",
          "## Setup",
          "Setup step one.",
          "### Details",
          "Fine print.",
          "## Setup",
          "A second setup heading (collision).",
          "## Usage",
          "How to use it.",
        ].join("\n"),
      });
      pageId = page.id;
    });

    test("outline lists headings with levels and unique anchors", async () => {
      const { outline } = await getPageOutline(pageId, ctx);
      expect(outline.map((h) => h.title)).toEqual([
        "Intro",
        "Setup",
        "Details",
        "Setup",
        "Usage",
      ]);
      const anchors = outline.map((h) => h.anchor);
      expect(new Set(anchors).size).toBe(anchors.length); // all unique
      expect(anchors).toContain("setup");
      expect(anchors).toContain("setup-2");
    });

    test("read-section returns the section incl. subsections up to the next same-level heading", async () => {
      const section = await readPageSection(pageId, "setup", ctx);
      expect(section.heading).toBe("Setup");
      expect(section.content).toContain("Setup step one.");
      // includes the deeper "### Details" subsection...
      expect(section.content).toContain("Fine print.");
      // ...but stops at the next "## Setup"
      expect(section.content).not.toContain("second setup heading");
    });

    test("read-section reports notFound for an unknown anchor", async () => {
      const section = await readPageSection(pageId, "no-such-anchor", ctx);
      expect(section.notFound).toBe(true);
    });
  });
});
