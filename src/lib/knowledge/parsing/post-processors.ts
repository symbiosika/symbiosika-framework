import type { PageContent } from "./pdf/types";

/**
 * Input handed to a post processor. Post processors run AFTER a document has
 * been parsed to markdown (PDF/OCR, URL, uploaded file, plain text) and BEFORE
 * it is stored — either as RAG knowledge entries or as knowledgeText wiki
 * pages. They may rewrite the text (e.g. clean up a datasheet via an LLM),
 * extract structured data, or suggest a better title.
 */
export type PostProcessorInput = {
  /**
   * The current document text (markdown). For multi-page documents this is
   * the concatenation of all page texts.
   */
  text: string;
  /**
   * Per-page structure when the parser provided it (e.g. Mistral OCR gives
   * one entry per page). A processor that rewrites the text should return an
   * updated `pages` array if it wants the page/citation mapping to survive
   * downstream (the RAG splitter stores `chunk.meta.page` from it). If a
   * processor rewrites the text but returns no `pages`, the mapping is
   * considered invalid and page-level metadata is dropped.
   */
  pages?: PageContent[];
  /** Current document title (file name / page title), if known. */
  title?: string;
  /** Where the document came from and what it contains. */
  source: {
    /** e.g. "url", "text", "external", "db", "local", "file" */
    type: string;
    url?: string;
    fileName?: string;
    mimeType?: string;
    includesImages: boolean;
  };
  /** Tenant scoping plus the optional acting user/team/workspace. */
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
  };
  /** Preferred LLM model, if the caller configured one. */
  model?: string;
};

/**
 * Result returned by a post processor. Only `text` is required.
 */
export type PostProcessorOutput = {
  /** The processed text (required). */
  text: string;
  /**
   * Updated page structure. Omit to signal that the page mapping is no longer
   * valid after this processor (downstream drops page-level metadata).
   */
  pages?: PageContent[];
  /** Optional replacement title. */
  title?: string;
  /**
   * Structured data extracted by the processor (e.g. datasheet fields).
   * Merged across processors and persisted into `knowledgeText.meta` on the
   * wiki import path.
   */
  meta?: Record<string, unknown>;
};

// PostProcessor type definition
export type PostProcessor = {
  name: string;
  label: string;
  description: string;
  execute: (input: PostProcessorInput) => Promise<PostProcessorOutput>;
};

/**
 * Aggregated result of running a chain of post processors.
 */
export type ApplyPostProcessorsResult = {
  text: string;
  pages?: PageContent[];
  title?: string;
  /** Merged `meta` of all processors (empty object if none produced any). */
  meta: Record<string, unknown>;
};

// Registry for post processors
const postProcessorRegistry: Record<string, PostProcessor> = {};

/**
 * Register a post processor. Should be called at app start.
 */
export function registerPostProcessor(processor: PostProcessor) {
  if (postProcessorRegistry[processor.name]) {
    throw new Error(
      `Post processor with name '${processor.name}' already registered.`
    );
  }
  postProcessorRegistry[processor.name] = processor;
}

/**
 * Get all registered post processors (read-only)
 */
export function getAllPostProcessors(): Omit<PostProcessor, "execute">[] {
  // Do not expose the execute function in the API
  return Object.values(postProcessorRegistry).map(
    ({ execute, ...rest }) => rest
  );
}

/**
 * Apply post processors by name, in order, to a parsed document. Each
 * processor receives the (possibly already modified) text/pages/title of the
 * previous one; structured `meta` outputs are merged.
 */
export async function applyPostProcessors(
  input: PostProcessorInput,
  processorNames?: string[]
): Promise<ApplyPostProcessorsResult> {
  let text = input.text;
  let pages = input.pages;
  let title = input.title;
  const meta: Record<string, unknown> = {};

  if (!processorNames || processorNames.length === 0) {
    return { text, pages, title, meta };
  }

  for (const name of processorNames) {
    const processor = postProcessorRegistry[name];
    if (!processor) {
      throw new Error(`Post processor '${name}' is not registered.`);
    }
    const result = await processor.execute({
      ...input,
      text,
      pages,
      title,
    });
    text = result.text;
    // A processor that rewrites the text invalidates the previous page
    // mapping unless it returns a fresh one. Adopt whatever it returned
    // (possibly undefined → page-level metadata is dropped downstream).
    pages = result.pages;
    if (result.title !== undefined) title = result.title;
    if (result.meta) {
      Object.assign(meta, result.meta);
    }
  }

  return { text, pages, title, meta };
}
