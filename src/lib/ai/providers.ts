/**
 * Provider construction for the central AI access layer.
 *
 * One place that knows how to turn a provider id into an AI-SDK language model
 * or embedding model, plus whether that provider is configured (has its API
 * key). Both text generation (`./index.ts`) and embeddings
 * (`../knowledge/embedding.ts`) build their models from here.
 *
 * We talk to OpenRouter via its OpenAI-compatible API through
 * `@ai-sdk/openai-compatible`, which is versioned in lockstep with the AI SDK
 * we use (like `@ai-sdk/mistral`) so the model-specification version matches
 * `ai` at runtime. The dedicated `@openrouter/ai-sdk-provider` targets a
 * different AI SDK major and would throw `AI_UnsupportedModelVersionError`.
 */

import type { EmbeddingModel, LanguageModel } from "ai";
import { mistral } from "@ai-sdk/mistral";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  AI_PROVIDER,
  EMBEDDING_PROVIDER,
  type AiProviderId,
  type EmbeddingProviderId,
} from "./types";

// --- OpenRouter (OpenAI-compatible) -----------------------------------------

const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/** Attribution headers recommended by OpenRouter (optional). */
const openRouterHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (process.env.OPENROUTER_REFERER)
    headers["HTTP-Referer"] = process.env.OPENROUTER_REFERER;
  if (process.env.OPENROUTER_TITLE)
    headers["X-Title"] = process.env.OPENROUTER_TITLE;
  return headers;
};

/** Build a fresh OpenRouter provider from the current environment. */
const openRouterProvider = () =>
  createOpenAICompatible({
    name: "openrouter",
    baseURL: OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    headers: openRouterHeaders(),
  });

// --- Configuration checks ---------------------------------------------------

/** True if the given text-generation provider has the env it needs to run. */
export const isTextProviderConfigured = (provider: AiProviderId): boolean => {
  switch (provider) {
    case AI_PROVIDER.MISTRAL:
      return !!process.env.MISTRAL_API_KEY;
    case AI_PROVIDER.OPENROUTER:
      return !!process.env.OPENROUTER_API_KEY;
    case AI_PROVIDER.NONE:
    default:
      return false;
  }
};

/** True if the given embedding provider has the env it needs to run. */
export const isEmbeddingProviderConfigured = (
  provider: EmbeddingProviderId
): boolean => {
  switch (provider) {
    case EMBEDDING_PROVIDER.MISTRAL:
      return !!process.env.MISTRAL_API_KEY;
    case EMBEDDING_PROVIDER.OPENROUTER:
      return !!process.env.OPENROUTER_API_KEY;
    default:
      return false;
  }
};

// --- Model builders ---------------------------------------------------------

/**
 * Build a language model for the given text-generation provider.
 * `modelId` overrides the provider's configured default model.
 * Returns `null` for `AI_PROVIDER.NONE`.
 */
export const buildLanguageModel = (
  provider: AiProviderId,
  modelId?: string
): LanguageModel | null => {
  switch (provider) {
    case AI_PROVIDER.MISTRAL:
      return mistral(
        modelId ?? process.env.MISTRAL_MODEL ?? "mistral-small-latest"
      );
    case AI_PROVIDER.OPENROUTER:
      return openRouterProvider().chatModel(
        modelId ?? process.env.OPENROUTER_MODEL ?? "mistralai/mistral-large"
      );
    case AI_PROVIDER.NONE:
    default:
      return null;
  }
};

/**
 * Build an embedding model for the given embedding provider.
 * `modelId` overrides the provider's configured default model.
 */
export const buildEmbeddingModel = (
  provider: EmbeddingProviderId,
  modelId?: string
): EmbeddingModel => {
  switch (provider) {
    case EMBEDDING_PROVIDER.MISTRAL:
      return mistral.textEmbeddingModel(
        modelId ?? process.env.MISTRAL_EMBEDDING_MODEL ?? "mistral-embed"
      );
    case EMBEDDING_PROVIDER.OPENROUTER:
      return openRouterProvider().textEmbeddingModel(
        modelId ??
          process.env.OPENROUTER_EMBEDDING_MODEL ??
          "openai/text-embedding-3-small"
      );
    default:
      throw new Error(`Unknown embedding provider "${provider}".`);
  }
};
