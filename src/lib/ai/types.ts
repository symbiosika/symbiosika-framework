/**
 * Provider identifiers for the framework's central AI access layer.
 *
 * Text generation and embeddings are configured independently (the same way
 * the PDF parser is selected via `PDF_PARSER_SERVICE`): text generation is
 * driven by `AI_PROVIDER`, embeddings by `EMBEDDING_PROVIDER`. Adding a new
 * provider means adding an id here and one registry entry in `./providers.ts`.
 */

/**
 * Providers usable for text generation (`generateText` / `generateStructured`
 * / agents).
 *
 * `none` is the default: it means "there is no globally configured LLM". In
 * that state every text-generation call site is disabled — features that
 * depend on it (e.g. page summaries) become no-ops rather than erroring, and
 * the low-level generation helpers throw `AiNotConfiguredError` if called
 * directly.
 */
export const AI_PROVIDER = {
  /** No global LLM configured. Text generation is disabled. */
  NONE: "none",
  /** Mistral, called directly against the Mistral API (`@ai-sdk/mistral`). */
  MISTRAL: "mistral",
  /** OpenRouter, via its OpenAI-compatible API (`@ai-sdk/openai-compatible`). */
  OPENROUTER: "openrouter",
} as const;

export type AiProviderId = (typeof AI_PROVIDER)[keyof typeof AI_PROVIDER];

/** The text-generation provider used when `AI_PROVIDER` is unset. */
export const DEFAULT_AI_PROVIDER: AiProviderId = AI_PROVIDER.NONE;

/**
 * Providers usable for embeddings.
 *
 * Embeddings power knowledge similarity search and are a distinct concern
 * from text generation — a deployment may run without a global LLM
 * (`AI_PROVIDER=none`) yet still need embeddings for search. There is
 * therefore no `none` here; the default is Mistral, preserving the historical
 * behaviour.
 *
 * NOTE: switching embedding provider changes the embedding vector dimension
 * (Mistral `mistral-embed` = 1024, OpenAI-style models typically 1536). The
 * knowledge schema stores both 1024- and 1536-dim vectors in separate columns,
 * so the dimension is selected per generation, but vectors created with one
 * model are not comparable to another. Changing this on a populated deployment
 * requires re-embedding. This is an operator decision, exactly like changing
 * `PDF_PARSER_SERVICE`.
 */
export const EMBEDDING_PROVIDER = {
  /** Mistral `mistral-embed` (1024 dims), called directly. */
  MISTRAL: "mistral",
  /** An OpenAI-compatible embeddings endpoint (e.g. OpenRouter). */
  OPENROUTER: "openrouter",
} as const;

export type EmbeddingProviderId =
  (typeof EMBEDDING_PROVIDER)[keyof typeof EMBEDDING_PROVIDER];

/** The embedding provider used when `EMBEDDING_PROVIDER` is unset. */
export const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProviderId =
  EMBEDDING_PROVIDER.MISTRAL;
