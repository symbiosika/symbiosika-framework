import { embed } from "ai";
import log from "../log";
import {
  DEFAULT_EMBEDDING_PROVIDER,
  type EmbeddingProviderId,
} from "../ai/types";
import {
  buildEmbeddingModel,
  isEmbeddingProviderConfigured,
} from "../ai/providers";

/**
 * The embedding provider selected via the `EMBEDDING_PROVIDER` env var, exactly
 * like `PDF_PARSER_SERVICE` selects the PDF parser. Defaults to Mistral, which
 * preserves the historical behaviour.
 *
 *   EMBEDDING_PROVIDER=mistral     (default) → mistral-embed (1024 dims)
 *   EMBEDDING_PROVIDER=openrouter  → OpenAI-compatible embeddings endpoint
 *
 * NOTE: different providers/models produce different vector dimensions and
 * vectors are only comparable within one model. Changing this on a populated
 * deployment requires re-embedding existing content.
 */
const getEmbeddingProvider = (): EmbeddingProviderId =>
  (process.env.EMBEDDING_PROVIDER as EmbeddingProviderId) ??
  DEFAULT_EMBEDDING_PROVIDER;

/**
 * Generate an embedding for the given text using the configured embedding
 * provider (Mistral by default).
 * @param text - The text to generate an embedding for
 * @param options - Options containing tenantId and userId (for future use)
 * @returns An object containing the embedding vector, model id and dimensions
 */
export const generateEmbedding = async (
  text: string,
  options: { tenantId?: string; userId?: string }
) => {
  const provider = getEmbeddingProvider();

  if (!isEmbeddingProviderConfigured(provider)) {
    log.error(
      `Embedding provider "${provider}" is not configured (missing API key).`
    );
    throw new Error(
      `Embedding provider "${provider}" is not configured. Set the matching ` +
        "API key (e.g. MISTRAL_API_KEY or OPENROUTER_API_KEY)."
    );
  }

  try {
    const model = buildEmbeddingModel(provider);
    const { embedding } = await embed({
      model,
      value: text,
    });

    // buildEmbeddingModel always returns a model object (never a bare string),
    // so modelId is present; the union type just doesn't narrow to it.
    const modelId =
      typeof model === "string" ? model : model.modelId;

    return {
      embedding,
      model: modelId,
      dimensions: embedding.length,
    };
  } catch (error) {
    log.error(`Error generating embedding: ${error}`);
    throw new Error(`Failed to generate embedding: ${error}`);
  }
};
