/**
 * Import external documents as knowledgeText wiki pages.
 *
 * Generalizes the ingestion that previously only existed for knowledge
 * entries (upload-and-extract): files and URLs are parsed to markdown and
 * become normal wiki pages — editable in the block editor, searchable,
 * linkable, and (opt-in) mirrored into the RAG pipeline via the existing
 * embedding sync.
 *
 *   - markdown / plain text / html files are converted directly
 *   - everything else (PDF, …) goes through the existing `parseFile`
 *     pipeline (external parser services)
 *   - the markdown is split into one block per top-level heading so the
 *     imported page is immediately block-editable (optional)
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { parseFile } from "./parsing";
import { urlToMarkdown } from "./parsing/url";
import { applyPostProcessors } from "./parsing/post-processors";
import {
  createKnowledgeText,
  updateKnowledgeText,
  getKnowledgeTextById,
} from "./knowledge-texts";
import {
  syncKnowledgeTextBlocks,
  type KnowledgeTextBlockInput,
} from "./knowledge-text-blocks";
import type {
  KnowledgeTextSelect,
  KnowledgeTextBlockSelect,
} from "../db/schema/knowledge";

export type ImportKnowledgeTextOptions = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  tenantWide?: boolean;
  parentId?: string;
  /** override the derived title (file name / page title) */
  title?: string;
  /** mirror the page into the RAG pipeline after import */
  embeddingEnabled?: boolean;
  /** split the markdown at top-level headings into blocks (default true) */
  splitIntoBlocks?: boolean;
  /** extra meta merged into the page meta */
  meta?: Record<string, unknown>;
  /**
   * Names of post processors to run on the parsed markdown before the page is
   * created (e.g. clean up / restructure a datasheet via an LLM). Any
   * structured `meta` they emit is merged into the page meta, and a returned
   * title overrides the derived one.
   */
  usePostProcessors?: string[];
};

export type ImportKnowledgeTextResult = {
  knowledgeText: KnowledgeTextSelect;
  blocks: KnowledgeTextBlockSelect[];
};

let turndown: TurndownService | null = null;
const getTurndown = (): TurndownService => {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    turndown.use(gfm);
  }
  return turndown;
};

const stripExtension = (name: string): string =>
  name.replace(/\.[^.]+$/, "");

/**
 * Split markdown into sections at top-level headings (# / ##), keeping code
 * fences intact. Returns at least one section for non-empty input.
 */
export const splitMarkdownIntoSections = (markdown: string): string[] => {
  const lines = markdown.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^(```|~~~)/.test(line.trim())) {
      inFence = !inFence;
    }
    if (
      !inFence &&
      /^#{1,2}\s/.test(line) &&
      current.join("\n").trim().length > 0
    ) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  const last = current.join("\n").trim();
  if (last.length > 0) sections.push(last);
  return sections;
};

/** Convert an uploaded file to markdown text */
const fileToMarkdown = async (
  file: File,
  context: { tenantId: string; userId?: string; teamId?: string; workspaceId?: string }
): Promise<string> => {
  const name = file.name ?? "";
  const mime = (file.type ?? "").trim().toLowerCase();

  if (
    mime.startsWith("text/markdown") ||
    /\.(md|markdown)$/i.test(name)
  ) {
    return await file.text();
  }
  if (mime.startsWith("text/html") || /\.html?$/i.test(name)) {
    return getTurndown().turndown(await file.text()).trim();
  }
  // PDF, plain text, … via the existing parsing pipeline
  const parsed = await parseFile(file, context);
  return parsed.text;
};

/**
 * Create a wiki page from already-parsed markdown. Shared by the file,
 * URL and sync ingestion paths.
 */
export const importMarkdownAsKnowledgeText = async (
  data: { title: string; text: string; sourceUri?: string },
  options: ImportKnowledgeTextOptions
): Promise<ImportKnowledgeTextResult> => {
  const context = {
    tenantId: options.tenantId,
    userId: options.userId,
    teamId: options.teamId,
    workspaceId: options.workspaceId,
  };

  // Run post processors on the parsed markdown before storing (e.g. clean up
  // / restructure a datasheet via an LLM). The cleaned text also feeds the
  // block splitting below, so imported pages get well-structured blocks.
  let text = data.text;
  let title = data.title;
  let processorMeta: Record<string, unknown> = {};
  if (options.usePostProcessors && options.usePostProcessors.length > 0) {
    const isUrl = /^https?:\/\//i.test(data.sourceUri ?? "");
    const processed = await applyPostProcessors(
      {
        text,
        title,
        source: {
          type: isUrl ? "url" : "file",
          url: isUrl ? data.sourceUri : undefined,
          fileName: isUrl ? undefined : data.sourceUri,
          includesImages: false,
        },
        context,
      },
      options.usePostProcessors
    );
    text = processed.text;
    if (processed.title) {
      title = processed.title;
    }
    processorMeta = processed.meta;
  }

  // create first WITHOUT the embedding flag so the page is embedded exactly
  // once, after its final content (blocks) is in place
  const page = await createKnowledgeText({
    tenantId: options.tenantId,
    userId: options.userId,
    teamId: options.teamId,
    tenantWide: options.tenantWide ?? false,
    parentId: options.parentId,
    title,
    text,
    meta: {
      ...(options.meta ?? {}),
      ...processorMeta,
      ...(data.sourceUri ? { sourceUri: data.sourceUri } : {}),
    },
  });

  let blocks: KnowledgeTextBlockSelect[] = [];
  if (options.splitIntoBlocks !== false) {
    const sections = splitMarkdownIntoSections(text);
    const blockInputs: KnowledgeTextBlockInput[] = sections.map(
      (content) => ({ type: "markdown", content })
    );
    const synced = await syncKnowledgeTextBlocks(
      page.id,
      blockInputs,
      context
    );
    blocks = synced.blocks;
  }

  let finalPage = options.splitIntoBlocks !== false ? undefined : page;
  if (options.embeddingEnabled) {
    // one embedding sync over the final content
    finalPage = await updateKnowledgeText(
      page.id,
      { embeddingEnabled: true },
      context
    );
  }
  if (!finalPage) {
    finalPage = await getKnowledgeTextById(page.id, context);
  }

  return { knowledgeText: finalPage, blocks };
};

/**
 * Import an uploaded file (markdown, html, plain text, PDF, …) as a wiki
 * page. The title defaults to the file name without extension.
 */
export const importKnowledgeTextFromFile = async (
  file: File,
  options: ImportKnowledgeTextOptions
): Promise<ImportKnowledgeTextResult> => {
  const text = await fileToMarkdown(file, {
    tenantId: options.tenantId,
    userId: options.userId,
    teamId: options.teamId,
    workspaceId: options.workspaceId,
  });
  if (text.trim().length === 0) {
    throw new Error("The file contains no extractable text");
  }
  const title =
    options.title ??
    (file.name ? stripExtension(file.name) : "Imported document");
  return await importMarkdownAsKnowledgeText(
    { title, text, sourceUri: file.name },
    options
  );
};

/**
 * Import a web page as a wiki page (Readability + Turndown, SSRF-guarded).
 * The title defaults to the extracted page title.
 */
export const importKnowledgeTextFromUrl = async (
  url: string,
  options: ImportKnowledgeTextOptions
): Promise<ImportKnowledgeTextResult> => {
  const result = await urlToMarkdown(url);
  if (result.markdown.trim().length === 0) {
    throw new Error("The page contains no extractable text");
  }
  return await importMarkdownAsKnowledgeText(
    { title: options.title ?? result.title, text: result.markdown, sourceUri: url },
    options
  );
};
