import type { Chunk } from "../types/chunks";
import type { PageContent } from "./parsing/pdf/types";
import { splitTextIntoSectionsOrChunks } from "./splitter";
import { smartSplitTextIntoSectionsOrChunks } from "./smart-splitter";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

/**
 * Chunking strategy selectable per app via `defineServer({ chunkingStrategy })`.
 *   - "simple": the original word/character splitter (default).
 *   - "smart":  markdown/table-aware splitter (keeps tables atomic, repeats
 *               table headers on oversized tables, paragraph/heading-aware text).
 */
export type ChunkingStrategy = "simple" | "smart";

/**
 * Split a parsed document (markdown string or `PageContent[]`) into chunks
 * using the configured strategy. Pass `strategy` to override the global config
 * (mainly for tests); otherwise the app-wide `chunkingStrategy` is used, which
 * defaults to "simple".
 */
export const splitDocumentIntoChunks = (
  input: string | PageContent[],
  strategy?: ChunkingStrategy
): Chunk[] => {
  const active = strategy ?? _GLOBAL_SERVER_CONFIG.chunkingStrategy ?? "simple";
  return active === "smart"
    ? smartSplitTextIntoSectionsOrChunks(input)
    : splitTextIntoSectionsOrChunks(input);
};
