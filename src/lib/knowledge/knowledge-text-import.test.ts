import { describe, it, expect, beforeAll } from "bun:test";
import {
  importKnowledgeTextFromFile,
  importMarkdownAsKnowledgeText,
  splitMarkdownIntoSections,
} from "./knowledge-text-import";
import { getKnowledgeTextBlocks } from "./knowledge-text-blocks";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

describe("splitMarkdownIntoSections", () => {
  it("splits at top-level headings", () => {
    const sections = splitMarkdownIntoSections(
      "# One\n\ntext one\n\n## Two\n\ntext two\n\n### Not split\n\nmore"
    );
    expect(sections.length).toBe(2);
    expect(sections[0]).toBe("# One\n\ntext one");
    expect(sections[1]).toContain("## Two");
    expect(sections[1]).toContain("### Not split");
  });

  it("keeps headings inside code fences intact", () => {
    const sections = splitMarkdownIntoSections(
      "# Doc\n\n```md\n# not a heading\n```\n\n## Real\n\nend"
    );
    expect(sections.length).toBe(2);
    expect(sections[0]).toContain("# not a heading");
  });

  it("returns a single section without headings", () => {
    expect(splitMarkdownIntoSections("just text\nno headings")).toEqual([
      "just text\nno headings",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(splitMarkdownIntoSections("   \n  ")).toEqual([]);
  });
});

describe("Knowledge Text Import", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("imports a markdown file split into blocks", async () => {
    const file = new File(
      ["# Handbook\n\nIntro text.\n\n## Chapter 1\n\nContent one."],
      "handbook.md",
      { type: "text/markdown" }
    );

    const result = await importKnowledgeTextFromFile(file, ctx);

    expect(result.knowledgeText.title).toBe("handbook");
    expect(result.knowledgeText.contentMode).toBe("blocks");
    expect(result.blocks.length).toBe(2);
    expect(result.blocks[0]?.content).toContain("# Handbook");
    expect(result.blocks[1]?.content).toContain("## Chapter 1");
    expect((result.knowledgeText.meta as any).sourceUri).toBe("handbook.md");
    // text cache materialized from the blocks
    expect(result.knowledgeText.text).toContain("Content one.");
  });

  it("imports a plain text file via the parsing pipeline", async () => {
    const file = new File(["Simple note content."], "note.txt", {
      type: "text/plain",
    });
    const result = await importKnowledgeTextFromFile(file, ctx);
    expect(result.knowledgeText.title).toBe("note");
    expect(result.knowledgeText.text).toBe("Simple note content.");
  });

  it("converts html files to markdown", async () => {
    const file = new File(
      ["<h1>Web Doc</h1><p>Hello <strong>world</strong></p>"],
      "page.html",
      { type: "text/html" }
    );
    const result = await importKnowledgeTextFromFile(file, ctx);
    expect(result.knowledgeText.text).toContain("# Web Doc");
    expect(result.knowledgeText.text).toContain("**world**");
  });

  it("respects title override and splitIntoBlocks=false", async () => {
    const file = new File(["# A\n\n## B\n\ntext"], "raw.md", {
      type: "text/markdown",
    });
    const result = await importKnowledgeTextFromFile(file, {
      ...ctx,
      title: "Custom Title",
      splitIntoBlocks: false,
    });

    expect(result.knowledgeText.title).toBe("Custom Title");
    expect(result.knowledgeText.contentMode).toBe("text");
    expect(result.blocks).toEqual([]);
    const blocks = await getKnowledgeTextBlocks(result.knowledgeText.id, ctx);
    expect(blocks.length).toBe(0);
  });

  it("rejects files without extractable text", async () => {
    const file = new File(["   "], "empty.md", { type: "text/markdown" });
    await expect(importKnowledgeTextFromFile(file, ctx)).rejects.toThrow(
      "no extractable text"
    );
  });

  it("import with embeddingEnabled never fails without a provider", async () => {
    const result = await importMarkdownAsKnowledgeText(
      { title: `Embed Import ${crypto.randomUUID()}`, text: "# Doc\n\ncontent" },
      { ...ctx, embeddingEnabled: true }
    );
    expect(result.knowledgeText.embeddingEnabled).toBe(true);
    // without MISTRAL_API_KEY the sync is skipped gracefully
  });

  it("supports wiki hierarchy via parentId", async () => {
    const parent = await importMarkdownAsKnowledgeText(
      { title: `Import Parent ${crypto.randomUUID()}`, text: "parent" },
      ctx
    );
    const child = await importMarkdownAsKnowledgeText(
      { title: `Import Child ${crypto.randomUUID()}`, text: "child" },
      { ...ctx, parentId: parent.knowledgeText.id }
    );
    expect(child.knowledgeText.parentId).toBe(parent.knowledgeText.id);
  });
});
