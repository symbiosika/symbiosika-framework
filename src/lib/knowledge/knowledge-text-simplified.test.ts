import { describe, it, expect, beforeAll } from "bun:test";
import { getSimplifiedKnowledgeText } from "./knowledge-text-simplified";
import { createKnowledgeText, updateKnowledgeText } from "./knowledge-texts";
import { syncKnowledgeTextBlocks } from "./knowledge-text-blocks";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

const createPage = async (overrides?: Record<string, unknown>) =>
  await createKnowledgeText({
    text: "",
    title: `Simplified Test ${crypto.randomUUID()}`,
    tenantId: TEST_ORGANISATION_1.id,
    ...overrides,
  });

describe("Simplified Knowledge Text", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("returns only id, title and content for a plain text page", async () => {
    const page = await createPage({
      title: "Plain Page",
      text: "# Plain\n\ncontent",
    });

    const result = await getSimplifiedKnowledgeText(page.id, ctx);

    expect(result).toEqual({
      id: page.id,
      title: "Plain Page",
      content: "# Plain\n\ncontent",
    });
    expect("children" in result).toBe(false);
  });

  it("merges all blocks into content for a block page", async () => {
    const page = await createPage({ title: "Block Page" });
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "# Heading" },
        { type: "html", content: "<p>From <strong>html</strong></p>" },
      ],
      ctx
    );

    const result = await getSimplifiedKnowledgeText(page.id, ctx);

    expect(result.content).toBe("# Heading\n\nFrom **html**");
    expect(result.title).toBe("Block Page");
    // no block structure leaks into the simplified shape
    expect(Object.keys(result).sort()).toEqual(["content", "id", "title"]);
  });

  it("returns the full nested subtree with recursive=true", async () => {
    const root = await createPage({ title: "Root", text: "root content" });
    const childA = await createPage({
      title: "A Child",
      text: "child a",
      parentId: root.id,
    });
    const childB = await createPage({
      title: "B Child",
      text: "child b",
      parentId: root.id,
    });
    const grandchild = await createPage({
      title: "Grandchild",
      text: "deep content",
      parentId: childA.id,
    });

    const result = await getSimplifiedKnowledgeText(root.id, ctx, {
      recursive: true,
    });

    expect(result.id).toBe(root.id);
    expect(result.content).toBe("root content");
    expect(result.children?.length).toBe(2);
    // no position set → ordered by title
    expect(result.children?.[0]?.id).toBe(childA.id);
    expect(result.children?.[1]?.id).toBe(childB.id);
    expect(result.children?.[0]?.children?.length).toBe(1);
    expect(result.children?.[0]?.children?.[0]?.id).toBe(grandchild.id);
    expect(result.children?.[0]?.children?.[0]?.content).toBe("deep content");
    // leaves carry an empty children array in recursive mode
    expect(result.children?.[1]?.children).toEqual([]);
  });

  it("orders children by manual position before title", async () => {
    const root = await createPage({ title: "Ordered Root" });
    const first = await createPage({
      title: "Z Should Be First",
      parentId: root.id,
      position: "f",
    });
    const second = await createPage({
      title: "A Should Be Second",
      parentId: root.id,
      position: "n",
    });
    const unpositioned = await createPage({
      title: "B Unpositioned Goes Last",
      parentId: root.id,
    });

    const result = await getSimplifiedKnowledgeText(root.id, ctx, {
      recursive: true,
    });

    expect(result.children?.map((c) => c.id)).toEqual([
      first.id,
      second.id,
      unpositioned.id,
    ]);
  });

  it("omits hidden sub-pages including their subtrees", async () => {
    const root = await createPage({ title: "Hidden Test Root" });
    const visible = await createPage({
      title: "Visible Child",
      parentId: root.id,
    });
    const hidden = await createPage({
      title: "Hidden Child",
      parentId: root.id,
      hidden: true,
    });
    await createPage({
      title: "Child Of Hidden",
      parentId: hidden.id,
    });

    const result = await getSimplifiedKnowledgeText(root.id, ctx, {
      recursive: true,
    });
    expect(result.children?.map((c) => c.id)).toEqual([visible.id]);

    // includeHidden brings the hidden subtree back
    const withHidden = await getSimplifiedKnowledgeText(
      root.id,
      { ...ctx, includeHidden: true },
      { recursive: true }
    );
    expect(withHidden.children?.length).toBe(2);
    const hiddenNode = withHidden.children?.find((c) => c.id === hidden.id);
    expect(hiddenNode?.children?.length).toBe(1);
  });

  it("survives a parentId cycle without infinite recursion", async () => {
    const a = await createPage({ title: "Cycle A", text: "a" });
    const b = await createPage({
      title: "Cycle B",
      text: "b",
      parentId: a.id,
    });
    // create the cycle: A's parent becomes B
    await updateKnowledgeText(a.id, { parentId: b.id }, ctx);

    const result = await getSimplifiedKnowledgeText(a.id, ctx, {
      recursive: true,
    });
    expect(result.id).toBe(a.id);
    expect(result.children?.[0]?.id).toBe(b.id);
    // the loop back to A is cut off
    expect(result.children?.[0]?.children).toEqual([]);
  });

  it("rejects access from a different tenant", async () => {
    const page = await createPage();
    await expect(
      getSimplifiedKnowledgeText(page.id, {
        tenantId: "00000000-1111-1111-1111-000000000002",
      })
    ).rejects.toThrow();
  });
});
