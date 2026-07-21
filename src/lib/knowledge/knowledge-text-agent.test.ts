import { describe, test, expect, beforeAll } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { createKnowledgeText, getKnowledgeTextById } from "./knowledge-texts";
import { getSimplifiedKnowledgeText } from "./knowledge-text-simplified";
import {
  resolvePageByTitle,
  listRecentChanges,
  getPagesBatch,
  appendToKnowledgeText,
} from "./knowledge-text-agent";

const TENANT = TEST_ORGANISATION_1.id;
const ctx = { tenantId: TENANT };

describe("context-economy endpoints", () => {
  beforeAll(async () => {
    await initTests();
  });

  test("resolvePageByTitle finds a page case-insensitively, without text", async () => {
    await createKnowledgeText({
      tenantId: TENANT,
      title: "Onboarding Guide",
      text: "secret body",
    });
    const resolved = await resolvePageByTitle("onboarding guide", ctx);
    expect(resolved).not.toBeNull();
    expect(resolved?.title).toBe("Onboarding Guide");
    expect(resolved).not.toHaveProperty("text");
  });

  test("returns null for an unknown title", async () => {
    expect(await resolvePageByTitle("does-not-exist-xyz", ctx)).toBeNull();
  });

  test("listRecentChanges returns pages newest-first without text", async () => {
    await createKnowledgeText({ tenantId: TENANT, title: "RC one", text: "a" });
    await createKnowledgeText({ tenantId: TENANT, title: "RC two", text: "b" });
    const recent = await listRecentChanges(ctx, { limit: 5 });
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent[0]).not.toHaveProperty("text");
    // sorted desc by updatedAt
    const times = recent.map((r) => String(r.updatedAt));
    const sorted = [...times].sort().reverse();
    expect(times).toEqual(sorted);
  });

  test("filters recent-changes by subtree (parentId)", async () => {
    const parent = await createKnowledgeText({
      tenantId: TENANT,
      title: "Subtree root",
      text: "root",
    });
    const child = await createKnowledgeText({
      tenantId: TENANT,
      title: "Subtree child",
      text: "child",
      parentId: parent.id,
    });
    const inSubtree = await listRecentChanges(ctx, { parentId: parent.id });
    const ids = inSubtree.map((r) => r.id);
    expect(ids).toContain(parent.id);
    expect(ids).toContain(child.id);
  });

  test("getPagesBatch returns requested pages in order", async () => {
    const p1 = await createKnowledgeText({
      tenantId: TENANT,
      title: "Batch A",
      text: "aa",
    });
    const p2 = await createKnowledgeText({
      tenantId: TENANT,
      title: "Batch B",
      text: "bb",
    });
    const withoutText = await getPagesBatch([p2.id, p1.id], ctx);
    expect(withoutText.map((r) => r.id)).toEqual([p2.id, p1.id]);
    expect(withoutText[0]).not.toHaveProperty("text");

    const withText = await getPagesBatch([p1.id], ctx, { includeText: true });
    expect(withText[0]?.text).toBe("aa");
  });

  test("appendToKnowledgeText concatenates and returns metadata only", async () => {
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: "Append target",
      text: "first",
    });
    const res = await appendToKnowledgeText(page.id, "second", ctx);
    expect(res.appendedChars).toBe("second".length);
    expect(res.totalChars).toBe("first\n\nsecond".length);
    // content actually updated
    const fetched = await getKnowledgeTextById(page.id, ctx);
    expect(fetched.text).toBe("first\n\nsecond");
    // append marks the summary stale (normal edit path)
    expect(fetched.summaryStale).toBe(true);
  });

  test("subtree respects maxDepth and flags omitted children", async () => {
    const root = await createKnowledgeText({
      tenantId: TENANT,
      title: "Depth root",
      text: "r",
    });
    const mid = await createKnowledgeText({
      tenantId: TENANT,
      title: "Depth mid",
      text: "m",
      parentId: root.id,
    });
    await createKnowledgeText({
      tenantId: TENANT,
      title: "Depth leaf",
      text: "l",
      parentId: mid.id,
    });

    const tree = await getSimplifiedKnowledgeText(root.id, ctx, {
      recursive: true,
      maxDepth: 1,
    });
    // root (0) -> mid (1); mid's children omitted at depth 1
    expect(tree.children?.length).toBe(1);
    const midNode = tree.children?.[0];
    expect(midNode?.childrenOmitted).toBe(true);
    expect(midNode?.children?.length).toBe(0);
  });

  test("subtree respects maxChars and flags truncation", async () => {
    const root = await createKnowledgeText({
      tenantId: TENANT,
      title: "Chars root",
      text: "X".repeat(100),
    });
    await createKnowledgeText({
      tenantId: TENANT,
      title: "Chars child",
      text: "Y".repeat(100),
      parentId: root.id,
    });

    const tree = await getSimplifiedKnowledgeText(root.id, ctx, {
      recursive: true,
      maxChars: 50,
    });
    expect(tree.content.length).toBe(50);
    expect(tree.contentTruncated).toBe(true);
    // budget exhausted → child content empty and flagged
    const childNode = tree.children?.[0];
    expect(childNode?.content).toBe("");
    expect(childNode?.contentTruncated).toBe(true);
  });
});
