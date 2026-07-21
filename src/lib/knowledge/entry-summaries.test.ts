import { describe, it, expect } from "bun:test";
import {
  buildEntryDescriptionInput,
  generateEntryDescription,
} from "./entry-summaries";

describe("buildEntryDescriptionInput", () => {
  it("passes short documents through in full", () => {
    const input = buildEntryDescriptionInput("My Doc", "Short body.", [
      { text: "Short body." },
    ]);
    expect(input).toBe("# My Doc\n\nShort body.");
  });

  it("compresses long documents to capped chunk leads", () => {
    const longText = "x".repeat(30_000);
    const chunks = Array.from({ length: 100 }, (_, i) => ({
      header: `Section ${i}`,
      text: "y".repeat(1_000),
    }));
    const input = buildEntryDescriptionInput("Long Doc", longText, chunks);
    expect(input.startsWith("# Long Doc")).toBe(true);
    expect(input).toContain("## Section 0");
    // per-chunk lead is sliced, never the full chunk
    expect(input).not.toContain("y".repeat(400));
    // overall budget cap
    expect(input.length).toBeLessThanOrEqual(16_000);
  });
});

describe("generateEntryDescription", () => {
  it("returns undefined when no global LLM is configured", async () => {
    const previous = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = "none";
    try {
      const description = await generateEntryDescription({
        title: "Doc",
        fullText: "Some content.",
        chunks: [{ text: "Some content." }],
      });
      expect(description).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = previous;
    }
  });
});
