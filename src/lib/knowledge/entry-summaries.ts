/**
 * AI description for RAG knowledge entries (`knowledge_entry.description`).
 *
 * Replaces the long-disabled summary code in add-knowledge.ts. Generation goes
 * through the central AI layer (`generateText`), so it uses the globally
 * configured text provider — no separate provider wiring. The result is a
 * single free-text paragraph, so plain text generation is used instead of
 * structured output (which not every model supports reliably).
 *
 * Behaviour:
 *   - gated on `isAiEnabled()`: without a configured global LLM the ingestion
 *     simply stores no description (as before) instead of failing;
 *   - a generation error never fails the ingestion — it is logged and the
 *     entry is stored without a description;
 *   - long documents are compressed to a chunk-based excerpt before the LLM
 *     call, so the cost per document is bounded regardless of its length.
 */

import { generateText, isAiEnabled } from "../ai";
import log from "../log";

/** Above this full-text length the LLM gets a chunk excerpt, not full text. */
const INPUT_COMPRESSION_THRESHOLD = 24_000;
/** Hard cap on the excerpt sent to the LLM. */
const INPUT_BUDGET = 16_000;
/** Per-chunk slice used when building the excerpt for long documents. */
const CHUNK_LEAD_LENGTH = 300;
/** DB check constraint: length(description) <= 10000. */
const MAX_DESCRIPTION_LENGTH = 10_000;

const DESCRIPTION_SYSTEM_PROMPT =
  "You write terse catalog descriptions for documents in a knowledge base. " +
  "Given a document (or an excerpt of a long one), respond with a 3-5 " +
  "sentence description of what the document contains and what questions it " +
  "can answer. Be concrete and specific; name the topic. Do not start with " +
  "'This document'. Write in the document's language. Respond with the " +
  "description text only — no preamble, no quotes, no markdown.";

/** Token cap for the generated description (3-5 sentences, bounds cost). */
const DESCRIPTION_MAX_OUTPUT_TOKENS = 500;

type SummaryChunk = { text: string; header?: string | null };

/**
 * Build the LLM input. Short documents are passed in full; long documents are
 * compressed to title + per-chunk leads (header + first lines), hard-capped to
 * a fixed budget — the same idea as `buildSummaryInput` in summaries.ts, but
 * chunk-based because the RAG pipeline already has the chunks at hand.
 */
export const buildEntryDescriptionInput = (
  title: string,
  fullText: string,
  chunks: SummaryChunk[]
): string => {
  if (fullText.length <= INPUT_COMPRESSION_THRESHOLD) {
    return `# ${title}\n\n${fullText}`;
  }

  const parts: string[] = [`# ${title}`];
  for (const chunk of chunks) {
    if (chunk.header) parts.push(`\n## ${chunk.header}`);
    parts.push(chunk.text.slice(0, CHUNK_LEAD_LENGTH));
  }
  return parts.join("\n").slice(0, INPUT_BUDGET);
};

/**
 * Generate the description for a knowledge entry, or `undefined` when no
 * global LLM is configured or the generation fails. Never throws — a missing
 * description must not fail the ingestion.
 */
export const generateEntryDescription = async (params: {
  title: string;
  fullText: string;
  chunks: SummaryChunk[];
  /** Provider-specific model id override (e.g. a cheaper summary model). */
  model?: string;
  /** Replaces the default system prompt when set. */
  customPrompt?: string;
}): Promise<string | undefined> => {
  if (!isAiEnabled()) {
    log.debug(
      `Skipping description for "${params.title}": no global LLM configured`
    );
    return undefined;
  }
  if (params.fullText.trim().length === 0) return undefined;

  try {
    const description = await generateText({
      system: params.customPrompt ?? DESCRIPTION_SYSTEM_PROMPT,
      prompt: buildEntryDescriptionInput(
        params.title,
        params.fullText,
        params.chunks
      ),
      model: params.model || undefined,
      maxOutputTokens: DESCRIPTION_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    });
    return description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
  } catch (error) {
    log.error(
      `Error generating description for knowledge entry "${params.title}": ${error}`
    );
    return undefined;
  }
};
