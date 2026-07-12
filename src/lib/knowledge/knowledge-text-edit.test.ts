import { describe, it, expect, beforeAll } from "bun:test";
import {
  readKnowledgeTextContent,
  editKnowledgeTextContent,
} from "./knowledge-text-edit";
import { createKnowledgeText } from "./knowledge-texts";
import {
  syncKnowledgeTextBlocks,
  getKnowledgeTextBlocks,
} from "./knowledge-text-blocks";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

const createPage = async (text: string) =>
  await createKnowledgeText({
    title: `Edit Test ${crypto.randomUUID()}`,
    text,
    tenantId: TEST_ORGANISATION_1.id,
  });

describe("Knowledge Text Read (file-like)", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("reads the full content with line metadata", async () => {
    const page = await createPage("line one\nline two\nline three");
    const view = await readKnowledgeTextContent(page.id, ctx);

    expect(view.content).toBe("line one\nline two\nline three");
    expect(view.fromLine).toBe(1);
    expect(view.toLine).toBe(3);
    expect(view.totalLines).toBe(3);
    expect(view.contentMode).toBe("text");
  });

  it("reads a line range", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const page = await createPage(lines.join("\n"));

    const view = await readKnowledgeTextContent(page.id, ctx, {
      fromLine: 5,
      maxLines: 3,
    });

    expect(view.content).toBe("line 5\nline 6\nline 7");
    expect(view.fromLine).toBe(5);
    expect(view.toLine).toBe(7);
    expect(view.totalLines).toBe(20);
  });

  it("rejects fromLine beyond the end", async () => {
    const page = await createPage("only one line");
    await expect(
      readKnowledgeTextContent(page.id, ctx, { fromLine: 99 })
    ).rejects.toThrow("beyond the end");
  });
});

describe("Knowledge Text Edit (string replacement)", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("replaces a unique string in a text page", async () => {
    const page = await createPage("The old value should change.");
    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "old value", newString: "new value" },
      ctx
    );

    expect(result.replacements).toBe(1);
    expect(result.content).toBe("The new value should change.");
  });

  it("rejects a non-unique string without replaceAll", async () => {
    const page = await createPage("dup here and dup there");
    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "dup", newString: "x" },
        ctx
      )
    ).rejects.toThrow("not unique");
  });

  it("replaces all occurrences with replaceAll", async () => {
    const page = await createPage("dup here and dup there");
    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "dup", newString: "item", replaceAll: true },
      ctx
    );
    expect(result.replacements).toBe(2);
    expect(result.content).toBe("item here and item there");
  });

  it("rejects a string that does not exist", async () => {
    const page = await createPage("some content");
    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "missing", newString: "x" },
        ctx
      )
    ).rejects.toThrow("not found in the document");
  });

  it("edits inside the affected block of a block page", async () => {
    const page = await createPage("");
    const saved = await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "# Stable heading" },
        { type: "markdown", content: "Body with a typo_here inside." },
      ],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "typo_here", newString: "correction" },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toContain("correction");

    // only the affected block changed, ids stayed stable
    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.id).toBe(saved.blocks[0]!.id);
    expect(blocks[0]?.content).toBe("# Stable heading");
    expect(blocks[1]?.id).toBe(saved.blocks[1]!.id);
    expect(blocks[1]?.content).toBe("Body with a correction inside.");
  });

  it("rejects an oldString that spans block boundaries", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "end of first" },
        { type: "markdown", content: "start of second" },
      ],
      ctx
    );

    // this string only exists in the materialized text across the block gap
    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "end of first\n\nstart of second", newString: "x" },
        ctx
      )
    ).rejects.toThrow("spans multiple blocks");
  });

  it("counts occurrences across blocks for uniqueness", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "shared word" },
        { type: "markdown", content: "another shared word" },
      ],
      ctx
    );

    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "shared", newString: "x" },
        ctx
      )
    ).rejects.toThrow("not unique");

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "shared", newString: "common", replaceAll: true },
      ctx
    );
    expect(result.replacements).toBe(2);
  });

  it("rejects empty or identical strings", async () => {
    const page = await createPage("content");
    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "", newString: "x" },
        ctx
      )
    ).rejects.toThrow("must not be empty");
    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "content", newString: "content" },
        ctx
      )
    ).rejects.toThrow("identical");
  });
});
