import { describe, it, expect, afterEach } from "bun:test";
import { splitDocumentIntoChunks } from "./chunking";
import { splitTextIntoSectionsOrChunks } from "./splitter";
import { smartSplitTextIntoSectionsOrChunks } from "./smart-splitter";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

// An oversized markdown table is the clearest behavioural difference between
// the two strategies: "smart" repeats the header in every part, "simple" does
// not.
const buildOversizedTable = (): string => {
  const lines = ["| Code | Meaning |", "|------|---------|"];
  for (let i = 0; i < 300; i++) {
    lines.push(`| E${i} | Error description number ${i} with some extra text |`);
  }
  return lines.join("\n");
};

describe("splitDocumentIntoChunks", () => {
  const originalStrategy = _GLOBAL_SERVER_CONFIG.chunkingStrategy;

  afterEach(() => {
    _GLOBAL_SERVER_CONFIG.chunkingStrategy = originalStrategy;
  });

  it("defaults to the simple strategy", () => {
    const table = buildOversizedTable();
    expect(splitDocumentIntoChunks(table)).toEqual(
      splitTextIntoSectionsOrChunks(table)
    );
    // Simple splitter does NOT repeat the header on every part.
    const chunks = splitDocumentIntoChunks(table);
    expect(chunks.every((c) => c.text.includes("| Code | Meaning |"))).toBe(
      false
    );
  });

  it("uses the smart strategy when passed explicitly", () => {
    const table = buildOversizedTable();
    const chunks = splitDocumentIntoChunks(table, "smart");

    expect(chunks).toEqual(smartSplitTextIntoSectionsOrChunks(table));
    expect(chunks.every((c) => c.text.includes("| Code | Meaning |"))).toBe(
      true
    );
  });

  it("honours the global config when no strategy is passed", () => {
    const table = buildOversizedTable();

    _GLOBAL_SERVER_CONFIG.chunkingStrategy = "smart";
    expect(splitDocumentIntoChunks(table)).toEqual(
      smartSplitTextIntoSectionsOrChunks(table)
    );

    _GLOBAL_SERVER_CONFIG.chunkingStrategy = "simple";
    expect(splitDocumentIntoChunks(table)).toEqual(
      splitTextIntoSectionsOrChunks(table)
    );
  });

  it("an explicit strategy overrides the global config", () => {
    const table = buildOversizedTable();

    _GLOBAL_SERVER_CONFIG.chunkingStrategy = "simple";
    expect(splitDocumentIntoChunks(table, "smart")).toEqual(
      smartSplitTextIntoSectionsOrChunks(table)
    );
  });
});
