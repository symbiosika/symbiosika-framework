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
import { parseFile, extractedMetadataToAttributes } from "./parsing";
import type { ExtractedValue } from "./parsing/pdf/types";
import { filterValidAttributes } from "./facets";
import { urlToMarkdown } from "./parsing/url";
import { applyPostProcessors } from "./parsing/post-processors";
import {
  createKnowledgeText,
  getKnowledgeTextById,
} from "./knowledge-texts";
import {
  syncKnowledgeTextBlocks,
  type KnowledgeTextBlockInput,
} from "./knowledge-text-blocks";
import { KNOWLEDGE_FILES_BUCKET } from "./knowledge-text-files";
import { syncKnowledgeTextEmbeddingSafe } from "./knowledge-text-embedding";
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
  /**
   * Parser pass-through options for file imports that go through the parsing
   * pipeline (PDF, …). Each extra service is only honoured when the configured
   * parsing service advertises the matching capability (see
   * `getConfiguredParserCapabilities`); an unsupported flag is simply ignored.
   */
  extractImages?: boolean;
  parseImagesInDoc?: boolean;
  ocr?: boolean;
  detectTables?: boolean;
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

/** Parser pass-through options honoured by file imports going through `parseFile`. */
type FileParserOptions = {
  extractImages?: boolean;
  parseImagesInDoc?: boolean;
  ocr?: boolean;
  detectTables?: boolean;
};

/**
 * Bucket for images a parser extracts from an imported document.
 *
 * The same bucket the block editor uploads into, deliberately: from the
 * moment the page exists, an extracted image IS a page image. Only there does
 * the page's file bookkeeping reach it — `syncKnowledgeTextFileReferences`
 * links it to the page on the first save, clears its expiry, and gives it the
 * grace-period expiry when the last reference (or the page) goes away. In the
 * parser's own default bucket it would instead sit outside the page
 * lifecycle: never cleaned up, and unreachable through the page-scoped image
 * endpoints that serve clients without the `files:read` scope.
 */
const IMPORT_IMAGE_BUCKET = KNOWLEDGE_FILES_BUCKET;

/** Convert an uploaded file to markdown text (plus any parser-extracted metadata) */
const fileToMarkdown = async (
  file: File,
  context: { tenantId: string; userId?: string; teamId?: string; workspaceId?: string },
  parserOptions?: FileParserOptions
): Promise<{ text: string; metadata?: Record<string, ExtractedValue> }> => {
  const name = file.name ?? "";
  const mime = (file.type ?? "").trim().toLowerCase();

  if (
    mime.startsWith("text/markdown") ||
    /\.(md|markdown)$/i.test(name)
  ) {
    return { text: await file.text() };
  }
  if (mime.startsWith("text/html") || /\.html?$/i.test(name)) {
    return { text: getTurndown().turndown(await file.text()).trim() };
  }
  // PDF, plain text, … via the existing parsing pipeline
  const parsed = await parseFile(file, context, {
    ...parserOptions,
    imageBucket: IMPORT_IMAGE_BUCKET,
  });
  return { text: parsed.text, metadata: parsed.metadata };
};

/**
 * Create a wiki page from already-parsed markdown. Shared by the file,
 * URL and sync ingestion paths.
 */
export const importMarkdownAsKnowledgeText = async (
  data: {
    title: string;
    text: string;
    sourceUri?: string;
    /**
     * Structured values a parsing service extracted for the tenant's catalog
     * attributes (see `enablePdfParserExtraction`). Valid entries are written
     * onto the new page's `attributes`; the raw result (with confidence) is
     * kept under `meta.parserExtraction` for provenance.
     */
    parserMetadata?: Record<string, ExtractedValue>;
  },
  options: ImportKnowledgeTextOptions
): Promise<ImportKnowledgeTextResult> => {
  const context = {
    tenantId: options.tenantId,
    userId: options.userId,
    teamId: options.teamId,
    workspaceId: options.workspaceId,
  };

  // Turn parser-extracted metadata into catalog attributes, keeping only
  // entries that pass facet validation (unknown keys / off-list enum values
  // are dropped so one bad value can't fail the whole import).
  let extractedAttributes: Record<string, string> = {};
  const hasExtraction =
    data.parserMetadata && Object.keys(data.parserMetadata).length > 0;
  if (hasExtraction) {
    extractedAttributes = await filterValidAttributes(
      options.tenantId,
      extractedMetadataToAttributes(data.parserMetadata)
    );
  }

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

  // embed only AFTER the final content (blocks) is in place, so the page is
  // embedded exactly once — and with block provenance. Whether it is embedded
  // at all is the organisation-wide setting's call (see
  // knowledge-embedding-settings.ts), not the importer's.
  const page = await createKnowledgeText({
    tenantId: options.tenantId,
    userId: options.userId,
    createdBy: options.userId,
    updatedBy: options.userId,
    teamId: options.teamId,
    tenantWide: options.tenantWide ?? false,
    parentId: options.parentId,
    title,
    text,
    ...(Object.keys(extractedAttributes).length > 0
      ? { attributes: extractedAttributes }
      : {}),
    meta: {
      ...(options.meta ?? {}),
      ...processorMeta,
      ...(data.sourceUri ? { sourceUri: data.sourceUri } : {}),
      ...(hasExtraction ? { parserExtraction: data.parserMetadata } : {}),
    },
  }, { skipEmbeddingSync: true });

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

  // one embedding sync over the final content (no-op when the organisation has
  // embedding switched off, or when the block sync above already did it)
  await syncKnowledgeTextEmbeddingSafe(page.id, options.tenantId);

  const finalPage = await getKnowledgeTextById(page.id, context);

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
  const { text, metadata } = await fileToMarkdown(
    file,
    {
      tenantId: options.tenantId,
      userId: options.userId,
      teamId: options.teamId,
      workspaceId: options.workspaceId,
    },
    {
      extractImages: options.extractImages,
      parseImagesInDoc: options.parseImagesInDoc,
      ocr: options.ocr,
      detectTables: options.detectTables,
    }
  );
  if (text.trim().length === 0) {
    throw new Error("The file contains no extractable text");
  }
  const title =
    options.title ??
    (file.name ? stripExtension(file.name) : "Imported document");
  return await importMarkdownAsKnowledgeText(
    { title, text, sourceUri: file.name, parserMetadata: metadata },
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
  const result = await urlToMarkdown(url, {
    parseContext: {
      tenantId: options.tenantId,
      userId: options.userId,
      teamId: options.teamId,
      workspaceId: options.workspaceId,
    },
    imageBucket: IMPORT_IMAGE_BUCKET,
  });
  if (result.markdown.trim().length === 0) {
    throw new Error("The page contains no extractable text");
  }
  return await importMarkdownAsKnowledgeText(
    { title: options.title ?? result.title, text: result.markdown, sourceUri: url },
    options
  );
};
