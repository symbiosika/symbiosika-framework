import { describe, it, expect } from "bun:test";
import { assignBlockProvenance, type BlockSpan } from "./block-provenance";
import { materializeBlocksTextWithSpans } from "./materialize-blocks";
import { splitTextIntoSectionsOrChunks } from "./splitter";
import { smartSplitTextIntoSectionsOrChunks } from "./smart-splitter";
import type { Chunk } from "../types/chunks";

/** Build spans quickly from block-id + text pairs joined by the real separator. */
const materialize = (blocks: { id: string; content: string }[]) =>
  materializeBlocksTextWithSpans(
    blocks.map((b) => ({ id: b.id, type: "markdown" as const, content: b.content }))
  );

describe("materializeBlocksTextWithSpans", () => {
  it("produces the same text as a plain \\n\\n join and exact spans", () => {
    const { text, spans } = materialize([
      { id: "a", content: "# Title" },
      { id: "b", content: "First paragraph." },
      { id: "c", content: "Second paragraph." },
    ]);

    expect(text).toBe("# Title\n\nFirst paragraph.\n\nSecond paragraph.");
    // every span points back at its exact source slice
    const contentById: Record<string, string> = {
      a: "# Title",
      b: "First paragraph.",
      c: "Second paragraph.",
    };
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(contentById[span.blockId]!);
    }
  });

  it("drops empty blocks from both text and spans", () => {
    const { text, spans } = materialize([
      { id: "a", content: "Alpha" },
      { id: "b", content: "   " },
      { id: "c", content: "Gamma" },
    ]);

    expect(text).toBe("Alpha\n\nGamma");
    expect(spans.map((s) => s.blockId)).toEqual(["a", "c"]);
  });
});

describe("assignBlockProvenance", () => {
  it("tags each chunk with the block it starts in (simple splitter)", () => {
    // three sizable sections, one per block, so the splitter emits >= 3 chunks
    // (each section alone exceeds the 500-word soft limit)
    const para = (word: string) => Array(600).fill(word).join(" ");
    const blocks = [
      { id: "blk-1", content: `# Section One\n\n${para("alpha")}` },
      { id: "blk-2", content: `# Section Two\n\n${para("bravo")}` },
      { id: "blk-3", content: `# Section Three\n\n${para("charlie")}` },
    ];
    const { text, spans } = materialize(blocks);

    const chunks = splitTextIntoSectionsOrChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    assignBlockProvenance(chunks, text, spans);

    // every chunk resolved to a real block id
    for (const chunk of chunks) {
      expect(chunk.meta?.blockId).toBeDefined();
      expect(["blk-1", "blk-2", "blk-3"]).toContain(chunk.meta!.blockId!);
    }
    // each chunk's first line really lives inside the block span it was
    // tagged with (i.e. the mapping is correct, not just non-empty)
    const spanById = new Map(spans.map((s) => [s.blockId, s]));
    for (const chunk of chunks) {
      const span = spanById.get(chunk.meta!.blockId!)!;
      const source = text.slice(span.start, span.end);
      const firstLine = chunk.text.split("\n").find((l) => l.trim().length > 0)!;
      expect(source).toContain(firstLine.trim());
    }
  });

  it("keeps chunk boundaries and text untouched", () => {
    const para = (word: string) => Array(120).fill(word).join(" ");
    const blocks = [
      { id: "b1", content: `# A\n\n${para("one")}` },
      { id: "b2", content: `# B\n\n${para("two")}` },
    ];
    const { text, spans } = materialize(blocks);

    const before = splitTextIntoSectionsOrChunks(text);
    const beforeSnapshot = before.map((c) => ({ text: c.text, order: c.order }));

    const after = splitTextIntoSectionsOrChunks(text);
    assignBlockProvenance(after, text, spans);

    expect(after.map((c) => ({ text: c.text, order: c.order }))).toEqual(
      beforeSnapshot
    );
  });

  it("works with the smart splitter too", () => {
    const para = (word: string) => Array(80).fill(word).join(" ");
    const blocks = [
      { id: "s1", content: `# One\n\n${para("uno")}` },
      { id: "s2", content: `# Two\n\n${para("dos")}` },
    ];
    const { text, spans } = materialize(blocks);

    const chunks = smartSplitTextIntoSectionsOrChunks(text);
    assignBlockProvenance(chunks, text, spans);

    for (const chunk of chunks) {
      expect(["s1", "s2"]).toContain(chunk.meta!.blockId!);
    }
  });

  it("no-ops when there are no spans", () => {
    const chunks: Chunk[] = [{ text: "hello", header: undefined, order: 0 }];
    assignBlockProvenance(chunks, "hello", []);
    expect(chunks[0]!.meta?.blockId).toBeUndefined();
  });

  it("inherits the previous block when an anchor cannot be located", () => {
    const spans: BlockSpan[] = [{ blockId: "only", start: 0, end: 5 }];
    const chunks: Chunk[] = [
      { text: "hello", header: undefined, order: 0 },
      { text: "not-in-source-text", header: undefined, order: 1 },
    ];
    assignBlockProvenance(chunks, "hello", spans);
    expect(chunks[0]!.meta?.blockId).toBe("only");
    // second chunk's anchor isn't in the source → inherits the first's block
    expect(chunks[1]!.meta?.blockId).toBe("only");
  });
});
