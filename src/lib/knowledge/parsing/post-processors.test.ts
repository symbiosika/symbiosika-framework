import { describe, it, expect } from "bun:test";
import {
  applyPostProcessors,
  registerPostProcessor,
  getAllPostProcessors,
  type PostProcessor,
  type PostProcessorInput,
} from "./post-processors";

/**
 * The registry is a module-level global and rejects duplicate names, so every
 * test registers processors under unique names.
 */
const baseInput = (
  overrides: Partial<PostProcessorInput> = {}
): PostProcessorInput => ({
  text: "original",
  source: { type: "text", includesImages: false },
  context: { tenantId: "t1" },
  ...overrides,
});

describe("applyPostProcessors", () => {
  it("returns the input unchanged when no processors are requested", async () => {
    const input = baseInput({
      text: "hello",
      title: "Title",
      pages: [{ page: 1, text: "hello" }],
    });

    const noneUndefined = await applyPostProcessors(input, undefined);
    const noneEmpty = await applyPostProcessors(input, []);

    for (const result of [noneUndefined, noneEmpty]) {
      expect(result.text).toBe("hello");
      expect(result.title).toBe("Title");
      expect(result.pages).toEqual([{ page: 1, text: "hello" }]);
      expect(result.meta).toEqual({});
    }
  });

  it("applies a single processor to the text", async () => {
    registerPostProcessor({
      name: "single-upper",
      label: "Upper",
      description: "uppercases",
      execute: async ({ text }) => ({ text: text.toUpperCase() }),
    });

    const result = await applyPostProcessors(
      baseInput({ text: "abc" }),
      ["single-upper"]
    );

    expect(result.text).toBe("ABC");
  });

  it("runs processors in the given order, threading text through the chain", async () => {
    const order: string[] = [];
    registerPostProcessor({
      name: "chain-a",
      label: "a",
      description: "append a",
      execute: async ({ text }) => {
        order.push("a");
        return { text: text + "-a" };
      },
    });
    registerPostProcessor({
      name: "chain-b",
      label: "b",
      description: "append b",
      execute: async ({ text }) => {
        order.push("b");
        return { text: text + "-b" };
      },
    });

    const forward = await applyPostProcessors(baseInput({ text: "x" }), [
      "chain-a",
      "chain-b",
    ]);
    expect(forward.text).toBe("x-a-b");
    expect(order).toEqual(["a", "b"]);

    // The same processors in the opposite order produce a different result.
    order.length = 0;
    const reverse = await applyPostProcessors(baseInput({ text: "x" }), [
      "chain-b",
      "chain-a",
    ]);
    expect(reverse.text).toBe("x-b-a");
    expect(order).toEqual(["b", "a"]);
  });

  it("each processor sees the previous processor's output as input", async () => {
    const seen: string[] = [];
    registerPostProcessor({
      name: "observe-first",
      label: "1",
      description: "",
      execute: async ({ text }) => {
        seen.push(text);
        return { text: text + "1" };
      },
    });
    registerPostProcessor({
      name: "observe-second",
      label: "2",
      description: "",
      execute: async ({ text }) => {
        seen.push(text);
        return { text: text + "2" };
      },
    });

    await applyPostProcessors(baseInput({ text: "start" }), [
      "observe-first",
      "observe-second",
    ]);

    expect(seen).toEqual(["start", "start1"]);
  });

  it("merges meta across processors (later processor wins on conflicts)", async () => {
    registerPostProcessor({
      name: "meta-a",
      label: "a",
      description: "",
      execute: async ({ text }) => ({
        text,
        meta: { shared: "from-a", onlyA: 1 },
      }),
    });
    registerPostProcessor({
      name: "meta-b",
      label: "b",
      description: "",
      execute: async ({ text }) => ({
        text,
        meta: { shared: "from-b", onlyB: 2 },
      }),
    });

    const result = await applyPostProcessors(baseInput(), [
      "meta-a",
      "meta-b",
    ]);

    expect(result.meta).toEqual({ shared: "from-b", onlyA: 1, onlyB: 2 });
  });

  it("overrides the title only when a processor returns one", async () => {
    registerPostProcessor({
      name: "title-none",
      label: "",
      description: "",
      execute: async ({ text }) => ({ text }),
    });
    registerPostProcessor({
      name: "title-set",
      label: "",
      description: "",
      execute: async ({ text }) => ({ text, title: "New Title" }),
    });

    const kept = await applyPostProcessors(
      baseInput({ title: "Original" }),
      ["title-none"]
    );
    expect(kept.title).toBe("Original");

    const replaced = await applyPostProcessors(
      baseInput({ title: "Original" }),
      ["title-none", "title-set"]
    );
    expect(replaced.title).toBe("New Title");
  });

  it("keeps pages when a processor returns them", async () => {
    registerPostProcessor({
      name: "pages-keep",
      label: "",
      description: "",
      execute: async ({ text, pages }) => ({ text, pages }),
    });

    const result = await applyPostProcessors(
      baseInput({ pages: [{ page: 1, text: "p1" }] }),
      ["pages-keep"]
    );

    expect(result.pages).toEqual([{ page: 1, text: "p1" }]);
  });

  it("drops pages when a processor rewrites text without returning pages", async () => {
    registerPostProcessor({
      name: "pages-drop",
      label: "",
      description: "",
      execute: async ({ text }) => ({ text: text + "!" }),
    });

    const result = await applyPostProcessors(
      baseInput({ pages: [{ page: 1, text: "p1" }] }),
      ["pages-drop"]
    );

    expect(result.pages).toBeUndefined();
  });

  it("passes source, context and model through to the processor", async () => {
    let received: PostProcessorInput | undefined;
    registerPostProcessor({
      name: "capture-input",
      label: "",
      description: "",
      execute: async (input) => {
        received = input;
        return { text: input.text };
      },
    });

    const input = baseInput({
      source: {
        type: "url",
        url: "https://example.com",
        includesImages: true,
      },
      context: { tenantId: "t9", userId: "u1", teamId: "team1" },
      model: "gpt-x",
    });
    await applyPostProcessors(input, ["capture-input"]);

    expect(received?.source).toEqual({
      type: "url",
      url: "https://example.com",
      includesImages: true,
    });
    expect(received?.context).toEqual({
      tenantId: "t9",
      userId: "u1",
      teamId: "team1",
    });
    expect(received?.model).toBe("gpt-x");
  });

  it("throws when a requested processor is not registered", async () => {
    await expect(
      applyPostProcessors(baseInput(), ["does-not-exist"])
    ).rejects.toThrow("Post processor 'does-not-exist' is not registered.");
  });
});

describe("registerPostProcessor", () => {
  it("throws when registering the same name twice", () => {
    const processor: PostProcessor = {
      name: "duplicate-name",
      label: "",
      description: "",
      execute: async ({ text }) => ({ text }),
    };
    registerPostProcessor(processor);
    expect(() => registerPostProcessor(processor)).toThrow(
      "Post processor with name 'duplicate-name' already registered."
    );
  });
});

describe("getAllPostProcessors", () => {
  it("exposes metadata but not the execute function", async () => {
    registerPostProcessor({
      name: "listed-processor",
      label: "Listed",
      description: "a listed processor",
      execute: async ({ text }) => ({ text }),
    });

    const listed = getAllPostProcessors().find(
      (p) => p.name === "listed-processor"
    );

    expect(listed).toEqual({
      name: "listed-processor",
      label: "Listed",
      description: "a listed processor",
    });
    expect((listed as Record<string, unknown>).execute).toBeUndefined();
  });
});
