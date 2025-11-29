import { embed } from "ai";
import { mistral } from "@ai-sdk/mistral";
import log from "../log";

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

/**
 * Generate an embedding for the given text using Mistral's embedding model
 * @param text - The text to generate an embedding for
 * @param options - Options containing tenantId and userId (for future use)
 * @returns An object containing the embedding vector and model identifier
 */
export const generateEmbedding = async (
  text: string,
  options: { tenantId?: string; userId?: string }
) => {
  if (!MISTRAL_API_KEY) {
    log.error("MISTRAL_API_KEY is not set in environment variables");
    throw new Error("Mistral API key is not configured");
  }

  try {
    const { embedding } = await embed({
      model: mistral.textEmbeddingModel("mistral-embed"),
      value: text,
    });

    return {
      embedding,
      model: "mistral-embed",
      dimensions: embedding.length,
    };
  } catch (error) {
    log.error(`Error generating embedding: ${error}`);
    throw new Error(`Failed to generate embedding: ${error}`);
  }
};
