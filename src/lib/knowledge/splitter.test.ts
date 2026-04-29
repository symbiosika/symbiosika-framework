import { describe, it, expect } from "bun:test";
import { splitTextIntoSectionsOrChunks, hardSplitText } from "./splitter";

// Mirror of the constant in `splitter.ts`. Kept in sync intentionally so the
// tests remain meaningful even if the implementation changes that value.
const MAX_CHARS_PER_CHUNK = 6000;

describe("splitTextIntoSectionsOrChunks", () => {
  it("should split text into chunks when exceeding MAX_WORDS_PER_CHUNK", () => {
    // Create a text with more than 500 words
    const words = Array(1500).fill("word").join(" ");
    const chunks = splitTextIntoSectionsOrChunks(words);

    expect(chunks).toHaveLength(3);
    if (!chunks[0] || !chunks[1]) return; // end test if chunk is undefined
    expect(chunks[0].order).toBe(0);
    expect(chunks[1].order).toBe(1);
    expect(chunks[0].text.split(" ").length).toBeLessThanOrEqual(500);
    expect(chunks[1].text.split(" ").length).toBeLessThanOrEqual(500);
  });

  it("should keep text as single chunk when under MAX_WORDS_PER_CHUNK", () => {
    const text = "This is a short text";
    const chunks = splitTextIntoSectionsOrChunks(text);

    expect(chunks).toHaveLength(1);
    if (!chunks[0]) return; // end test if chunk is undefined
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].order).toBe(0);
    expect(chunks[0].header).toBeUndefined();
  });

  it("should preserve whitespace in chunks", () => {
    const text = "First line\nSecond line\n\nThird line";
    const chunks = splitTextIntoSectionsOrChunks(text);

    expect(chunks).toHaveLength(1);
    if (!chunks[0]) return; // end test if chunk is undefined
    expect(chunks[0].text).toBe(text);
  });

  // -----------------------------------------------------------------
  // Regression tests for the knowledge-sync chunking failures
  // (Mistral mistral-embed has a hard 8192 token limit; these inputs
  // previously slipped through the splitter as single multi-MB chunks.)
  // -----------------------------------------------------------------

  it("should hard-split a single line that exceeds the char limit even with few words", () => {
    // 200 "words", each 200 chars long, joined without whitespace inside a
    // single line. countWords -> 200 (under MAX_WORDS_PER_CHUNK), but the
    // line itself is 200 * 200 + 199 = 40_199 chars long.
    const longWord = "x".repeat(200);
    const line = Array(200).fill(longWord).join(" ");
    expect(line.length).toBeGreaterThan(MAX_CHARS_PER_CHUNK);

    const chunks = splitTextIntoSectionsOrChunks(line);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
    chunks.forEach((c, idx) => expect(c.order).toBe(idx));
  });

  it("should hard-split a single line with no whitespace at all", () => {
    // Pathological input: 50_000 chars of a single "word".
    const line = "a".repeat(50_000);
    const chunks = splitTextIntoSectionsOrChunks(line);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
    // No content should be lost.
    const reassembled = chunks
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((c) => c.text)
      .join("");
    expect(reassembled.length).toBe(line.length);
  });

  it("should split a markdown-table-like document where every line contains a pipe", () => {
    // Reproduces the "stuck insideTable" bug: every line has `|`, so the
    // original splitter never flushed and produced one giant chunk.
    const tableLine =
      "| col_a | col_b | col_c | " + "filler ".repeat(80) + "|";
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(tableLine);
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(MAX_CHARS_PER_CHUNK);

    const chunks = splitTextIntoSectionsOrChunks(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
  });

  it("should split a single page from PageContent[] that exceeds the char limit", () => {
    // PDF parser produces an array of pages. A single page that is huge (or
    // OCR garbage with no structure) must still be split.
    const hugePageText = "lorem ".repeat(20_000); // ~120k chars
    const chunks = splitTextIntoSectionsOrChunks([
      { page: 1, text: "Short intro page" },
      { page: 2, text: hugePageText },
      { page: 3, text: "Short outro page" },
    ]);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
    // Order must be unique and contiguous starting at 0.
    chunks.forEach((c, idx) => expect(c.order).toBe(idx));
    // Page meta must be preserved on the split pieces.
    expect(chunks.some((c) => c.meta?.page === 2)).toBe(true);
  });

  it("should not lose content when hard-splitting (round-trip)", () => {
    const text = "abc ".repeat(5_000); // 20_000 chars, plenty of whitespace.
    const chunks = splitTextIntoSectionsOrChunks(text);

    const reassembled = chunks
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((c) => c.text)
      .join("");

    // The splitter may collapse some whitespace, but every non-whitespace
    // character must survive.
    const stripped = (s: string) => s.replace(/\s+/g, "");
    expect(stripped(reassembled)).toBe(stripped(text));
  });
});

describe("hardSplitText", () => {
  it("returns the input untouched when it already fits", () => {
    const text = "small";
    expect(hardSplitText(text)).toEqual([text]);
  });

  it("splits at paragraph boundaries when available", () => {
    const para = "x".repeat(5_500);
    const text = para + "\n\n" + para; // 11_002 chars total
    const parts = hardSplitText(text);

    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
  });

  it("falls back to a hard cut when no boundary exists", () => {
    const text = "x".repeat(20_000);
    const parts = hardSplitText(text);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
    expect(parts.join("").length).toBe(text.length);
  });
});
