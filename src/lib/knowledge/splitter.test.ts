import { describe, it, expect } from "bun:test";
import { splitTextIntoSectionsOrChunks } from "./splitter";

describe("splitTextIntoSectionsOrChunks", () => {
  it("should split text into chunks when exceeding MAX_WORDS_PER_CHUNK", () => {
    // Create a text with more than 500 words
    const words = Array(1500).fill("word").join(" ");
    const chunks = splitTextIntoSectionsOrChunks(words);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].order).toBe(0);
    expect(chunks[1].order).toBe(1);
    expect(chunks[0].text.split(" ").length).toBeLessThanOrEqual(500);
    expect(chunks[1].text.split(" ").length).toBeLessThanOrEqual(500);
  });

  it("should keep text as single chunk when under MAX_WORDS_PER_CHUNK", () => {
    const text = "This is a short text";
    const chunks = splitTextIntoSectionsOrChunks(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].order).toBe(0);
    expect(chunks[0].header).toBeUndefined();
  });

  it("should preserve whitespace in chunks", () => {
    const text = "First line\nSecond line\n\nThird line";
    const chunks = splitTextIntoSectionsOrChunks(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
  });
});
