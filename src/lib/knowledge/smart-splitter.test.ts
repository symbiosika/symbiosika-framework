import { describe, it, expect } from "bun:test";
import { smartSplitTextIntoSectionsOrChunks } from "./smart-splitter";

// Mirror of the constants in `splitter.ts` (kept in sync intentionally).
const MAX_CHARS_PER_CHUNK = 6000;
const MAX_WORDS_PER_CHUNK = 500;

const buildMarkdownTable = (rows: number): string => {
  const lines = ["| Code | Meaning |", "|------|---------|"];
  for (let i = 0; i < rows; i++) {
    lines.push(`| E${i} | Error description number ${i} with some extra text |`);
  }
  return lines.join("\n");
};

describe("smartSplitTextIntoSectionsOrChunks", () => {
  it("keeps a short text as a single chunk", () => {
    const text = "This is a short text";
    const chunks = smartSplitTextIntoSectionsOrChunks(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
    expect(chunks[0]!.order).toBe(0);
    expect(chunks[0]!.header).toBeUndefined();
  });

  it("keeps a small markdown table atomic (one chunk)", () => {
    const table = buildMarkdownTable(5); // well under the char cap
    expect(table.length).toBeLessThan(MAX_CHARS_PER_CHUNK);

    const chunks = smartSplitTextIntoSectionsOrChunks(table);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(table);
  });

  it("splits an oversized table and repeats the header row in every part", () => {
    const table = buildMarkdownTable(300); // > char cap
    expect(table.length).toBeGreaterThan(MAX_CHARS_PER_CHUNK);

    const chunks = smartSplitTextIntoSectionsOrChunks(table);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Every part is self-contained: it repeats the header + separator.
      expect(chunk.text).toContain("| Code | Meaning |");
      expect(chunk.text).toContain("|------|---------|");
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
    // order is contiguous starting at 0.
    chunks.forEach((c, idx) => expect(c.order).toBe(idx));
  });

  it("keeps a short heading directly before a table together with it", () => {
    const input =
      "## Error codes\n\n| Code | Meaning |\n|---|---|\n| E1 | foo |\n| E2 | bar |";
    const chunks = smartSplitTextIntoSectionsOrChunks(input);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("Error codes");
    expect(chunks[0]!.text).toContain("| E1 | foo |");
    expect(chunks[0]!.header).toBe("Error codes");
  });

  it("chunks free text at heading boundaries and records the header", () => {
    const input =
      "# First\n\nSome text under first.\n\n# Second\n\nSome text under second.";
    const chunks = smartSplitTextIntoSectionsOrChunks(input);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.header).toBe("First");
    expect(chunks[0]!.text).toContain("Some text under first.");
    expect(chunks[1]!.header).toBe("Second");
    expect(chunks[1]!.text).toContain("Some text under second.");
  });

  it("bundles multiple short paragraphs up to the word budget", () => {
    // Ten short paragraphs, no headings → should collapse into a single chunk.
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph number ${i}.`);
    const chunks = smartSplitTextIntoSectionsOrChunks(paras.join("\n\n"));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text.split(/\s+/).length).toBeLessThanOrEqual(
      MAX_WORDS_PER_CHUNK
    );
  });

  it("hard-splits an oversized single paragraph and enforces the char cap", () => {
    const huge = "lorem ".repeat(20_000); // ~120k chars, one paragraph
    const chunks = smartSplitTextIntoSectionsOrChunks(huge);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
    chunks.forEach((c, idx) => expect(c.order).toBe(idx));
  });

  it("preserves whitespace-collapsed content on a round trip", () => {
    const text = "abc ".repeat(5_000);
    const chunks = smartSplitTextIntoSectionsOrChunks(text);

    const reassembled = chunks
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((c) => c.text)
      .join("");
    const stripped = (s: string) => s.replace(/\s+/g, "");
    expect(stripped(reassembled)).toBe(stripped(text));
  });

  it("processes PageContent[] and preserves the page number in meta", () => {
    const hugePageText = "lorem ".repeat(20_000);
    const chunks = smartSplitTextIntoSectionsOrChunks([
      { page: 1, text: "Short intro page" },
      { page: 2, text: hugePageText },
      { page: 3, text: "Short outro page" },
    ]);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
    chunks.forEach((c, idx) => expect(c.order).toBe(idx));
    expect(chunks.some((c) => c.meta?.page === 1)).toBe(true);
    expect(chunks.some((c) => c.meta?.page === 2)).toBe(true);
    expect(chunks.some((c) => c.meta?.page === 3)).toBe(true);
  });

  it("returns no chunks for empty input", () => {
    expect(smartSplitTextIntoSectionsOrChunks("")).toEqual([]);
  });
});
