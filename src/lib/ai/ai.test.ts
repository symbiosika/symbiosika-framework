import { describe, test, expect, afterEach } from "bun:test";
import {
  isAiEnabled,
  getAiProvider,
  getStandardModel,
  getModel,
  generateText,
  generateStructured,
  salvageStructuredText,
  AiNotConfiguredError,
} from "./index";
import { AI_PROVIDER } from "./types";
import { isTextProviderConfigured } from "./providers";
import * as v from "valibot";

/**
 * These tests exercise provider selection and the "no global LLM" gating.
 * They never hit a real model — only configuration logic.
 */

const ORIGINAL_ENV = {
  AI_PROVIDER: process.env.AI_PROVIDER,
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_STRUCTURED_OUTPUTS: process.env.OPENROUTER_STRUCTURED_OUTPUTS,
};

afterEach(() => {
  process.env.AI_PROVIDER = ORIGINAL_ENV.AI_PROVIDER;
  process.env.MISTRAL_API_KEY = ORIGINAL_ENV.MISTRAL_API_KEY;
  process.env.OPENROUTER_API_KEY = ORIGINAL_ENV.OPENROUTER_API_KEY;
  process.env.OPENROUTER_STRUCTURED_OUTPUTS =
    ORIGINAL_ENV.OPENROUTER_STRUCTURED_OUTPUTS;
});

describe("AI provider layer", () => {
  test("defaults to 'none' when AI_PROVIDER is unset", () => {
    delete process.env.AI_PROVIDER;
    expect(getAiProvider()).toBe(AI_PROVIDER.NONE);
    expect(isAiEnabled()).toBe(false);
    expect(getStandardModel()).toBeNull();
    expect(getModel("some-model")).toBeNull();
  });

  test("'none' disables generation even if API keys are present", () => {
    process.env.AI_PROVIDER = AI_PROVIDER.NONE;
    process.env.MISTRAL_API_KEY = "sk-test";
    expect(isAiEnabled()).toBe(false);
    expect(getStandardModel()).toBeNull();
  });

  test("mistral provider is enabled only when its API key is set", () => {
    process.env.AI_PROVIDER = AI_PROVIDER.MISTRAL;
    delete process.env.MISTRAL_API_KEY;
    expect(isAiEnabled()).toBe(false);
    expect(isTextProviderConfigured(AI_PROVIDER.MISTRAL)).toBe(false);

    process.env.MISTRAL_API_KEY = "sk-test";
    expect(isAiEnabled()).toBe(true);
    expect(getStandardModel()).not.toBeNull();
  });

  test("openrouter provider is enabled only when its API key is set", () => {
    process.env.AI_PROVIDER = AI_PROVIDER.OPENROUTER;
    delete process.env.OPENROUTER_API_KEY;
    expect(isAiEnabled()).toBe(false);

    process.env.OPENROUTER_API_KEY = "sk-or-test";
    expect(isAiEnabled()).toBe(true);
    expect(getStandardModel()).not.toBeNull();
  });

  test("generateText throws AiNotConfiguredError when no provider is configured", async () => {
    delete process.env.AI_PROVIDER;
    await expect(generateText({ prompt: "hi" })).rejects.toBeInstanceOf(
      AiNotConfiguredError
    );
  });

  test("generateStructured throws AiNotConfiguredError when no provider is configured", async () => {
    delete process.env.AI_PROVIDER;
    await expect(
      generateStructured({
        schema: v.object({ x: v.string() }),
        system: "s",
        prompt: "p",
      })
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  test("openrouter models request structured outputs by default", () => {
    process.env.AI_PROVIDER = AI_PROVIDER.OPENROUTER;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    delete process.env.OPENROUTER_STRUCTURED_OUTPUTS;

    const model = getStandardModel() as { supportsStructuredOutputs?: boolean };
    expect(model?.supportsStructuredOutputs).toBe(true);
  });

  test("OPENROUTER_STRUCTURED_OUTPUTS=false disables structured outputs", () => {
    process.env.AI_PROVIDER = AI_PROVIDER.OPENROUTER;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.OPENROUTER_STRUCTURED_OUTPUTS = "false";

    const model = getStandardModel() as { supportsStructuredOutputs?: boolean };
    expect(model?.supportsStructuredOutputs).toBe(false);
  });
});

describe("salvageStructuredText", () => {
  const schema = v.object({ summary: v.string() });

  test("parses plain JSON", () => {
    expect(
      salvageStructuredText(schema, '{"summary": "A page about X."}')
    ).toEqual({ summary: "A page about X." });
  });

  test("parses JSON inside a fenced code block", () => {
    const text = 'Here you go:\n```json\n{"summary": "Fenced."}\n```\nDone.';
    expect(salvageStructuredText(schema, text)).toEqual({
      summary: "Fenced.",
    });
  });

  test("parses JSON surrounded by prose", () => {
    const text = 'Sure! {"summary": "Embedded."} Hope that helps.';
    expect(salvageStructuredText(schema, text)).toEqual({
      summary: "Embedded.",
    });
  });

  test("rejects JSON that does not match the schema", () => {
    expect(salvageStructuredText(schema, '{"other": 1}')).toBeNull();
  });

  test("returns null for non-JSON text or missing text", () => {
    expect(salvageStructuredText(schema, "no json here")).toBeNull();
    expect(salvageStructuredText(schema, undefined)).toBeNull();
  });
});
