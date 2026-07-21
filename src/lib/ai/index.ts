/**
 * Central AI access for the framework (text generation).
 *
 * All LLM / agent text calls go through this module so every call site shares
 * one provider configuration. The provider is selected with the `AI_PROVIDER`
 * env var (see `./types.ts`), exactly like `PDF_PARSER_SERVICE` selects the PDF
 * parser:
 *
 *   AI_PROVIDER=none        (default) → no global LLM; generation is disabled
 *   AI_PROVIDER=mistral     → Mistral API (MISTRAL_API_KEY, MISTRAL_MODEL)
 *   AI_PROVIDER=openrouter  → OpenRouter (OPENROUTER_API_KEY, OPENROUTER_MODEL)
 *
 * When no provider is configured (`none`, or a provider whose API key is
 * missing), `isAiEnabled()` returns false. Feature code should check that and
 * skip the feature (summaries, etc.); the low-level `generateText` /
 * `generateStructured` helpers throw `AiNotConfiguredError` if called anyway,
 * so a misconfiguration fails loudly rather than silently.
 *
 * Embeddings are configured separately (`EMBEDDING_PROVIDER`) and live in
 * `../knowledge/embedding.ts`.
 */

import {
  generateText as aiGenerateText,
  generateObject,
  type LanguageModel,
} from "ai";
import { valibotSchema } from "@ai-sdk/valibot";
import type { GenericSchema } from "valibot";
import log from "../log";
import {
  AI_PROVIDER,
  DEFAULT_AI_PROVIDER,
  type AiProviderId,
} from "./types";
import { buildLanguageModel, isTextProviderConfigured } from "./providers";

export * from "./types";

/** Thrown when a text-generation call is made without a configured provider. */
export class AiNotConfiguredError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "No AI provider is configured. Set AI_PROVIDER (mistral|openrouter) " +
          "and the matching API key to enable text generation."
    );
    this.name = "AiNotConfiguredError";
  }
}

/** The text-generation provider selected via `AI_PROVIDER` (default `none`). */
export const getAiProvider = (): AiProviderId =>
  (process.env.AI_PROVIDER as AiProviderId) ?? DEFAULT_AI_PROVIDER;

/**
 * Whether a global LLM is available for text generation: a non-`none` provider
 * that also has its API key configured. Feature code should gate on this.
 */
export const isAiEnabled = (): boolean => {
  const provider = getAiProvider();
  return provider !== AI_PROVIDER.NONE && isTextProviderConfigured(provider);
};

/**
 * The standard language model, or `null` when no provider is configured.
 * Callers that can degrade gracefully should prefer this over the throwing
 * helpers below.
 */
export const getStandardModel = (): LanguageModel | null =>
  buildLanguageModel(getAiProvider());

/**
 * Resolve a language model by (provider-specific) model id, falling back to the
 * configured default when no id is given. Returns `null` when no provider is
 * configured. Use for per-request model overrides (e.g. a tenant-configured
 * agent, or a cheaper model for a trivial task like summaries).
 */
export const getModel = (modelId?: string): LanguageModel | null =>
  buildLanguageModel(getAiProvider(), modelId);

/** Throws `AiNotConfiguredError` unless a provider is configured. */
export const assertAiConfigured = (): void => {
  if (!isAiEnabled()) throw new AiNotConfiguredError();
};

const requireModel = (modelId?: string): LanguageModel => {
  const model = getModel(modelId);
  if (!model) throw new AiNotConfiguredError();
  return model;
};

/**
 * Generate plain text from the model. Thin wrapper around the AI SDK
 * `generateText` so every call site shares the same provider + config.
 */
export const generateText = async (params: {
  prompt: string;
  system?: string;
  /** Provider-specific model id override; defaults to the configured model. */
  model?: string;
  /** Upper bound on generated tokens (keeps trivial tasks cheap). */
  maxOutputTokens?: number;
  /** 0..1; lower is more deterministic. */
  temperature?: number;
}): Promise<string> => {
  const model = requireModel(params.model);
  const { text } = await aiGenerateText({
    model,
    system: params.system,
    prompt: params.prompt,
    maxOutputTokens: params.maxOutputTokens,
    temperature: params.temperature,
  });
  return text;
};

/**
 * Generate a structured object from the model using a valibot schema. The AI
 * SDK forces the model to produce output matching the schema and validates it.
 */
export const generateStructured = async <T>(params: {
  schema: GenericSchema<T>;
  system: string;
  prompt: string;
  /** Provider-specific model id override; defaults to the configured model. */
  model?: string;
}): Promise<T> => {
  const model = requireModel(params.model);
  const { object } = await generateObject({
    model,
    schema: valibotSchema(params.schema),
    system: params.system,
    prompt: params.prompt,
  });
  return object as T;
};

/** Log the resolved AI configuration once at startup (no secrets). */
export const logAiConfiguration = (): void => {
  const provider = getAiProvider();
  if (provider === AI_PROVIDER.NONE) {
    log.info("AI text generation: disabled (AI_PROVIDER=none)");
  } else if (!isTextProviderConfigured(provider)) {
    log.error(
      `AI text generation: AI_PROVIDER="${provider}" but its API key is not ` +
        "set — generation features are disabled."
    );
  } else {
    log.info(`AI text generation: enabled (provider="${provider}")`);
  }
};
