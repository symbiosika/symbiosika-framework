import { describe, it, expect, beforeAll } from "bun:test";
import {
  getKnowledgeTextBlocks,
  syncKnowledgeTextBlocks,
  convertKnowledgeTextToBlocks,
  materializeBlocksText,
} from "./knowledge-text-blocks";
import {
  createKnowledgeText,
  getKnowledgeTextById,
  getKnowledgeTextHistory,
  deleteKnowledgeText,
} from "./knowledge-texts";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

const createPage = async (overrides?: Record<string, unknown>) =>
  await createKnowledgeText({
    text: "",
    title: `Block Test Page ${crypto.randomUUID()}`,
    tenantId: TEST_ORGANISATION_1.id,
    ...overrides,
  });

describe("materializeBlocksText", () => {
  it("joins markdown blocks with blank lines", () => {
    const text = materializeBlocksText([
      { type: "markdown", content: "# Heading" },
      { type: "markdown", content: "Some paragraph." },
    ]);
    expect(text).toBe("# Heading\n\nSome paragraph.");
  });

  it("converts html blocks to markdown", () => {
    const text = materializeBlocksText([
      { type: "html", content: "<h2>Title</h2><p>Hello <strong>world</strong></p>" },
    ]);
    expect(text).toContain("## Title");
    expect(text).toContain("**world**");
  });

  it("skips empty blocks", () => {
    const text = materializeBlocksText([
      { type: "markdown", content: "A" },
      { type: "markdown", content: "   " },
      { type: "markdown", content: "B" },
    ]);
    expect(text).toBe("A\n\nB");
  });
});

describe("Knowledge Text Blocks", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("returns an empty block list for a plain text page", async () => {
    const page = await createPage({ text: "plain text" });
    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks).toEqual([]);
  });

  it("creates blocks via sync and switches the page to block mode", async () => {
    const page = await createPage();

    const result = await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "# Hello" },
        { type: "html", content: "<p>World</p>" },
      ],
      ctx
    );

    expect(result.changes).toEqual({ inserted: 2, updated: 0, deleted: 0 });
    expect(result.blocks.length).toBe(2);
    expect(result.blocks[0]?.type).toBe("markdown");
    expect(result.blocks[1]?.type).toBe("html");
    expect(result.blocks[0]!.position < result.blocks[1]!.position).toBe(true);
    expect(result.knowledgeText.contentMode).toBe("blocks");
    // text cache materialized (html converted to markdown)
    expect(result.knowledgeText.text).toBe("# Hello\n\nWorld");
  });

  it("keeps client-provided block ids", async () => {
    const page = await createPage();
    const clientId = crypto.randomUUID();

    const result = await syncKnowledgeTextBlocks(
      page.id,
      [{ id: clientId, type: "markdown", content: "tracked" }],
      ctx
    );

    expect(result.blocks[0]?.id).toBe(clientId);
  });

  it("updates changed blocks and leaves unchanged ones untouched", async () => {
    const page = await createPage();
    const first = await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "one" },
        { type: "markdown", content: "two" },
      ],
      ctx
    );
    const [b1, b2] = first.blocks;

    const second = await syncKnowledgeTextBlocks(
      page.id,
      [
        { id: b1!.id, type: "markdown", content: "one" },
        { id: b2!.id, type: "markdown", content: "two changed" },
      ],
      ctx
    );

    expect(second.changes).toEqual({ inserted: 0, updated: 1, deleted: 0 });
    expect(second.blocks[0]?.id).toBe(b1!.id);
    expect(second.blocks[0]?.position).toBe(b1!.position); // untouched
    expect(second.blocks[1]?.content).toBe("two changed");
    expect(second.knowledgeText.text).toBe("one\n\ntwo changed");
  });

  it("is a no-op when the same block list is saved again", async () => {
    const page = await createPage();
    const first = await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: "stable" }],
      ctx
    );

    const second = await syncKnowledgeTextBlocks(
      page.id,
      [{ id: first.blocks[0]!.id, type: "markdown", content: "stable" }],
      ctx
    );

    expect(second.changes).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(second.historyCreated).toBe(false);
    expect(second.blocks[0]?.position).toBe(first.blocks[0]!.position);
  });

  it("deletes blocks missing from the payload", async () => {
    const page = await createPage();
    const first = await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "keep" },
        { type: "markdown", content: "remove" },
      ],
      ctx
    );

    const second = await syncKnowledgeTextBlocks(
      page.id,
      [{ id: first.blocks[0]!.id, type: "markdown", content: "keep" }],
      ctx
    );

    expect(second.changes.deleted).toBe(1);
    expect(second.blocks.length).toBe(1);
    expect(second.knowledgeText.text).toBe("keep");
  });

  it("reorders blocks while keeping ids stable", async () => {
    const page = await createPage();
    const first = await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "A" },
        { type: "markdown", content: "B" },
        { type: "markdown", content: "C" },
      ],
      ctx
    );
    const [a, b, c] = first.blocks;

    // move C to the front
    const second = await syncKnowledgeTextBlocks(
      page.id,
      [
        { id: c!.id, type: "markdown", content: "C" },
        { id: a!.id, type: "markdown", content: "A" },
        { id: b!.id, type: "markdown", content: "B" },
      ],
      ctx
    );

    expect(second.blocks.map((blk) => blk.content)).toEqual(["C", "A", "B"]);
    expect(second.blocks.map((blk) => blk.id).sort()).toEqual(
      [a!.id, b!.id, c!.id].sort()
    );
    expect(second.knowledgeText.text).toBe("C\n\nA\n\nB");
    // ordering is strictly ascending
    for (let i = 1; i < second.blocks.length; i++) {
      expect(
        second.blocks[i - 1]!.position < second.blocks[i]!.position
      ).toBe(true);
    }
  });

  it("inserts a new block between existing ones without moving them", async () => {
    const page = await createPage();
    const first = await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "top" },
        { type: "markdown", content: "bottom" },
      ],
      ctx
    );
    const [top, bottom] = first.blocks;

    const second = await syncKnowledgeTextBlocks(
      page.id,
      [
        { id: top!.id, type: "markdown", content: "top" },
        { type: "markdown", content: "middle" },
        { id: bottom!.id, type: "markdown", content: "bottom" },
      ],
      ctx
    );

    expect(second.changes).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    // existing blocks kept their positions
    expect(second.blocks[0]?.position).toBe(top!.position);
    expect(second.blocks[2]?.position).toBe(bottom!.position);
    expect(second.blocks.map((blk) => blk.content)).toEqual([
      "top",
      "middle",
      "bottom",
    ]);
  });

  it("stores block meta and detects meta-only changes", async () => {
    const page = await createPage();
    const first = await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: "code", meta: { language: "ts" } }],
      ctx
    );
    expect(first.blocks[0]?.meta).toEqual({ language: "ts" });

    const second = await syncKnowledgeTextBlocks(
      page.id,
      [
        {
          id: first.blocks[0]!.id,
          type: "markdown",
          content: "code",
          meta: { language: "python" },
        },
      ],
      ctx
    );
    expect(second.changes.updated).toBe(1);
    expect(second.blocks[0]?.meta).toEqual({ language: "python" });
  });

  it("writes a history snapshot of the previous state including blocks", async () => {
    const page = await createPage();
    await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: "version 1" }],
      ctx,
      { historyCoalesceMinutes: 0 }
    );

    const second = await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: "version 2" }],
      ctx,
      { historyCoalesceMinutes: 0 }
    );
    expect(second.historyCreated).toBe(true);

    const history = await getKnowledgeTextHistory(page.id, ctx);
    expect(history.length).toBeGreaterThanOrEqual(2);
    // newest history entry contains the previous ("version 1") state
    expect(history[0]?.text).toBe("version 1");
    expect(history[0]?.contentMode).toBe("blocks");
    expect(Array.isArray(history[0]?.blocks)).toBe(true);
    expect((history[0]?.blocks as any[])[0]?.content).toBe("version 1");
    // the very first snapshot preserved the empty text-mode state
    expect(history[history.length - 1]?.contentMode).toBe("text");
    expect(history[history.length - 1]?.blocks).toBeNull();
  });

  it("coalesces history snapshots within the window", async () => {
    const page = await createPage();
    await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: "v1" }],
      ctx
    );
    const baseline = (await getKnowledgeTextHistory(page.id, ctx)).length;

    // rapid autosaves — all inside the coalescing window
    for (const content of ["v2", "v3", "v4"]) {
      const result = await syncKnowledgeTextBlocks(
        page.id,
        [{ type: "markdown", content }],
        ctx
      );
      expect(result.historyCreated).toBe(false);
    }

    const after = (await getKnowledgeTextHistory(page.id, ctx)).length;
    expect(after).toBe(baseline);
  });

  it("converts a legacy text page into a single markdown block", async () => {
    const page = await createPage({ text: "# Legacy\n\ncontent here" });
    expect(page.contentMode).toBe("text");

    const result = await convertKnowledgeTextToBlocks(page.id, ctx);

    expect(result.knowledgeText.contentMode).toBe("blocks");
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0]?.type).toBe("markdown");
    expect(result.blocks[0]?.content).toBe("# Legacy\n\ncontent here");
    // text cache unchanged
    expect(result.knowledgeText.text).toBe("# Legacy\n\ncontent here");
    // conversion left a restore point of the text version
    const history = await getKnowledgeTextHistory(page.id, ctx);
    expect(history[0]?.contentMode).toBe("text");

    // converting again is a no-op
    const again = await convertKnowledgeTextToBlocks(page.id, ctx);
    expect(again.changes).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(again.blocks.length).toBe(1);
  });

  it("converts an empty text page into zero blocks", async () => {
    const page = await createPage({ text: "" });
    const result = await convertKnowledgeTextToBlocks(page.id, ctx);
    expect(result.knowledgeText.contentMode).toBe("blocks");
    expect(result.blocks.length).toBe(0);
  });

  it("cascade-deletes blocks when the page is deleted", async () => {
    const page = await createPage();
    await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: "to be deleted" }],
      ctx
    );

    await deleteKnowledgeText(page.id, ctx);

    await expect(getKnowledgeTextById(page.id, ctx)).rejects.toThrow();
  });

  it("strips NUL bytes (U+0000) from block content before storing", async () => {
    const page = await createPage();
    const result = await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: "ocr \u0000 artifact\u0000" }],
      ctx
    );

    // block rows and the materialized text cache are both NUL-free
    expect(result.blocks[0]?.content).toBe("ocr  artifact");
    expect(result.knowledgeText.text).toBe("ocr  artifact");
  });

  it("rejects access from a different tenant", async () => {
    const page = await createPage();
    await expect(
      getKnowledgeTextBlocks(page.id, {
        tenantId: "00000000-1111-1111-1111-000000000002",
      })
    ).rejects.toThrow();
    await expect(
      syncKnowledgeTextBlocks(
        page.id,
        [{ type: "markdown", content: "x" }],
        { tenantId: "00000000-1111-1111-1111-000000000002" }
      )
    ).rejects.toThrow();
  });
});
