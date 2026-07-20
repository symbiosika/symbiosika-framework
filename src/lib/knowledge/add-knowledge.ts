/*
 This library contains functions to extract knowledge from textes and store them in different ways.
 
 It will get an in input from an already uploaded file and extract the knowledge from it.

 This will be done in a few steps:
 - Get the input file and parse it into text/markdown
 - Try to split the text into logical sections. This can be done for example by headings. Output = blocks of texts
 - If no sections are found we will still have a long text. Try to split it by paragraphs then. Output = blocks of texts
 - Check the word count of each block. If it is too high we will split it into smaller chunks. Output = Chunks
 - For each chunk create a knowledge object.
    - Create a summary of the chunk?
*/
import { getDb } from "../db/db-connection";
import log from "../log";
import type { FileSourceType } from "../storage";
import { splitDocumentIntoChunks } from "./chunking";
import type { ChunkWithEmbedding } from "../types/chunks";
import {
  knowledgeChunks,
  knowledgeEntry,
  type KnowledgeChunksInsert,
  type KnowledgeEntryInsert,
} from "../db/schema/knowledge";
import { parseDocument, parseFile } from "./parsing";
import { applyPostProcessors } from "./parsing/post-processors";
import { urlToMarkdown } from "./parsing/url";
import type { PageContent } from "./parsing/pdf/types";
import { generateEmbedding } from "./embedding";

/**
 * Helper function to store a knowledge entry in the database
 */
export const storeKnowledgeEntry = async (
  data: KnowledgeEntryInsert,
  filters: Record<string, string>
) => {
  const db = getDb();

  // Store the main entry
  const [entry] = await db.insert(knowledgeEntry).values(data).returning();

  if (!entry) {
    throw new Error("Error storing knowledge entry");
  }

  return entry;
};

/**
 * Helper to store a knowledge chunk in the database
 */
const storeKnowledgeChunk = async (data: KnowledgeChunksInsert) => {
  try {
    const result = await getDb()
      .insert(knowledgeChunks)
      .values(data)
      .returning();
    log.debug(
      `Stored knowledge chunk with id: ${result[0]?.id}, text length: ${data.text?.length || 0}`
    );
    return result[0];
  } catch (error) {
    log.error(`Error in storeKnowledgeChunk: ${error}`);
    throw error;
  }
};

/**
 * Extract knowledge from a file and store it in the database
 */
export const extractKnowledgeFromText = async (data: {
  tenantId: string;
  title: string;
  text?: string;
  pages?: PageContent[];
  filters?: Record<string, string>;
  metadata?: Record<string, string | number | boolean | undefined>;
  sourceType?: FileSourceType;
  sourceFileBucket?: string;
  sourceId?: string;
  sourceExternalId?: string;
  sourceUrl?: string;
  /** Optional sha256 of the source, persisted to `knowledge_entry.source_hash`. */
  sourceHash?: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  includesLocalImages?: boolean;
  generateSummary?: boolean;
  summaryCustomPrompt?: string;
  summaryModel?: string;
}) => {
  const title = data.title;

  // Get full text for text-based operations
  let fullText = data.text || "";
  if (!data.text && data.pages) {
    fullText = data.pages.map((page) => page.text).join("\n\n");
  }

  // Split the content into chunks - now handles both text and pages
  const chunks = splitDocumentIntoChunks(data.pages || fullText);

  // Generate embeddings for all chunks
  const allEmbeddings: ChunkWithEmbedding[] = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const embedding = await generateEmbedding(chunk.text, {
          tenantId: data.tenantId,
          userId: data.userId,
        });
        return { ...chunk, embedding };
      } catch (e) {
        log.error(`Error generating embedding for chunk: ${chunk.text}`);
        log.debug(`Chunk length: ${chunk.text.length}`);
        throw new Error(
          "Error generating embedding for Chunk with text-length: " +
            chunk.text.length +
            ". " +
            e
        );
      }
    })
  );
  log.debug(`Embeddings generated. Chunks: ${chunks.length}`);

  // Generate summary if requested
  let description = undefined;
  let abstract = undefined;

  if (data.generateSummary ?? true) {
    log.debug(`Generating summary for knowledge entry: ${title}`);

    // Use chunk-based summary generation for longer texts
    if (fullText.length > 10000 && chunks.length > 1) {
      log.debug(`Using chunk-based summary generation for long document`);
      // const summary = await generateChunkBasedSummary(
      //   chunks,
      //   data.title,
      //   {
      //     tenantId: data.tenantId,
      //     userId: data.userId,
      //   },
      //   {
      //     model: data.summaryModel,
      //     customPrompt: data.summaryCustomPrompt,
      //   }
      // );
      // description = summary.description;
    } else {
      // Use the original method for shorter texts
      // const summary = await generateDocumentSummary(
      //   fullText,
      //   data.title,
      //   {
      //     tenantId: data.tenantId,
      //     userId: data.userId,
      //   },
      //   {
      //     model: data.summaryModel,
      //     customPrompt: data.summaryCustomPrompt,
      //   }
      // );
      // description = summary.description;
    }
  }

  // merge metadata
  const meta = {
    ...(data.metadata ?? {}),
    textLength: fullText.length,
    includesLocalImages: data.includesLocalImages,
    pageCount: data.pages?.length,
  };

  // Store the main entry in the database
  await log.debug(`Store knowledge entry: ${title}`);
  const knowledgeEntry = await storeKnowledgeEntry(
    {
      ...data,
      tenantId: data.tenantId,
      name: title,
      meta,
      sourceHash: data.sourceHash,
      userId: data.userId,
      teamId: data.teamId,
      knowledgeGroupId: data.knowledgeGroupId,
      userOwned: data.userOwned,
      description,
    },
    data.filters || {}
  );

  // Store the chunks in the database
  await log.debug(`Store knowledge chunks: ${allEmbeddings.length}`);
  await Promise.all(
    allEmbeddings.map((e) => {
      return storeKnowledgeChunk({
        knowledgeEntryId: knowledgeEntry.id,
        text: e.text,
        header: e.header,
        order: e.order,
        embeddingModel: e.embedding.model,
        textEmbedding1536: e.embedding.dimensions === 1536 ? e.embedding.embedding : null,
        textEmbedding1024: e.embedding.dimensions === 1024 ? e.embedding.embedding : null,
        meta: e.meta,
      });
    })
  );
  return {
    id: knowledgeEntry.id,
    ok: true,
  };
};

/**
 * Extract knowledge from a file and store it in the database
 */
export const extractKnowledgeFromExistingDbEntry = async (data: {
  tenantId: string;
  sourceType: FileSourceType;
  sourceId?: string;
  sourceFileBucket?: string;
  sourceUrl?: string;
  filters?: Record<string, string>;
  metadata?: Record<string, string | number | boolean | undefined>;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  model?: string;
  extractImages?: boolean;
  generateSummary?: boolean;
  summaryCustomPrompt?: string;
  summaryModel?: string;
  usePostProcessors?: string[];
}) => {
  // Get the file (from DB or local disc) or content from URL
  let { content, pages, title, includesImages } = await parseDocument(data);

  return extractKnowledgeFromText({
    title,
    text: content,
    pages: pages,
    filters: data.filters,
    metadata: data.metadata,
    sourceType: data.sourceType,
    sourceFileBucket: data.sourceFileBucket,
    sourceId: data.sourceId,
    sourceUrl: data.sourceUrl,
    tenantId: data.tenantId,
    userId: data.userId,
    teamId: data.teamId,
    workspaceId: data.workspaceId,
    knowledgeGroupId: data.knowledgeGroupId,
    userOwned: data.userOwned,
    includesLocalImages: includesImages,
    generateSummary: data.generateSummary,
    summaryCustomPrompt: data.summaryCustomPrompt,
    summaryModel: data.summaryModel,
  });
};

/**
 * Extract knowledge from a file or text and store it in the database
 */
export const extractKnowledgeInOneStep = async (
  data: {
    tenantId: string;
    filters?: Record<string, string>;
    teamId?: string;
    workspaceId?: string;
    knowledgeGroupId?: string;
    userOwned?: boolean;
    file?: File;
    data?: {
      title: string;
      text: string;
    };
    meta?: {
      sourceUri: string;
      sourceId: string;
    };
    generateSummary?: boolean;
    summaryCustomPrompt?: string;
    summaryModel?: string;
    model?: string;
    usePostProcessors?: string[];
  },
  overwrite?: boolean
) => {
  const bucket = "default";

  // if the file is provided, extract knowledge from it
  if (data.file) {
    // 1. parse file content
    const parsed = await parseFile(data.file, {
      tenantId: data.tenantId,
      teamId: data.teamId,
      workspaceId: data.workspaceId,
    });

    // 2. optional post processing (e.g. clean up a datasheet via an LLM)
    let text = parsed.text;
    let pages = parsed.pages;
    let title = data.file.name ?? "Unknown";
    if (data.usePostProcessors && data.usePostProcessors.length > 0) {
      const processed = await applyPostProcessors(
        {
          text,
          pages,
          title,
          source: {
            type: "external",
            fileName: data.file.name,
            mimeType: data.file.type,
            includesImages: parsed.includesImages,
          },
          context: {
            tenantId: data.tenantId,
            teamId: data.teamId,
            workspaceId: data.workspaceId,
          },
          model: data.model,
        },
        data.usePostProcessors
      );
      text = processed.text;
      pages = processed.pages;
      if (processed.title) {
        title = processed.title;
      }
    }

    // 3. Extract knowledge
    const result = await extractKnowledgeFromText({
      tenantId: data.tenantId,
      title,
      text,
      pages,
      filters: data.filters,
      teamId: data.teamId,
      workspaceId: data.workspaceId,
      knowledgeGroupId: data.knowledgeGroupId,
      userOwned: data.userOwned,
      sourceType: "external",
      sourceExternalId: data.meta?.sourceId ?? data.file.name,
      sourceFileBucket: bucket,
      sourceUrl: data.meta?.sourceUri ?? data.file.name,
      includesLocalImages: parsed.includesImages,
      generateSummary: data.generateSummary,
      summaryCustomPrompt: data.summaryCustomPrompt,
      summaryModel: data.summaryModel,
    });
    return result;
  }
  // if the text is provided, extract knowledge from it
  else if (data.data) {
    // optional post processing before extraction
    let text = data.data.text;
    let title = data.data.title;
    if (data.usePostProcessors && data.usePostProcessors.length > 0) {
      const processed = await applyPostProcessors(
        {
          text,
          title,
          source: { type: "text", includesImages: false },
          context: {
            tenantId: data.tenantId,
            teamId: data.teamId,
            workspaceId: data.workspaceId,
          },
          model: data.model,
        },
        data.usePostProcessors
      );
      text = processed.text;
      if (processed.title) {
        title = processed.title;
      }
    }

    return extractKnowledgeFromText({
      tenantId: data.tenantId,
      title,
      text,
      filters: data.filters,
      teamId: data.teamId,
      workspaceId: data.workspaceId,
      knowledgeGroupId: data.knowledgeGroupId,
      userOwned: data.userOwned,
      sourceExternalId: data.meta?.sourceId ?? data.data.title,
      sourceType: "external",
      sourceFileBucket: bucket,
      sourceUrl: data.meta?.sourceUri ?? data.data.title,
      includesLocalImages: false,
      generateSummary: data.generateSummary,
      summaryCustomPrompt: data.summaryCustomPrompt,
      summaryModel: data.summaryModel,
    });
  }
  // if no file and no text is provided, throw an error
  else {
    throw new Error("No file or text provided");
  }
};

/**
 * Extract knowledge from a web page (HTML → markdown via Readability/Turndown,
 * or a linked PDF) and store it as a knowledge entry.
 *
 * Extracted from the former synchronous `POST .../knowledge/from-url` route so
 * the exact same logic can now run inside a background job. Returns
 * `{ id, ok }` — the created knowledge entry id.
 */
export const extractKnowledgeFromUrl = async (data: {
  tenantId: string;
  url: string;
  filters?: Record<string, string>;
  teamId?: string;
  userId?: string;
  workspaceId?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  usePostProcessors?: string[];
}) => {
  if (!data.url.startsWith("http://") && !data.url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }

  const parsed = await urlToMarkdown(data.url, {
    parseContext: { tenantId: data.tenantId },
  });

  if (!parsed.markdown || parsed.markdown.trim().length === 0) {
    throw new Error(`No readable content could be extracted from ${data.url}`);
  }

  const processed = await applyPostProcessors(
    {
      text: parsed.markdown,
      title: parsed.title,
      source: { type: "url", url: data.url, includesImages: false },
      context: { tenantId: data.tenantId, userId: data.userId },
    },
    data.usePostProcessors
  );

  return extractKnowledgeFromText({
    userId: data.userId,
    tenantId: data.tenantId,
    title: processed.title ?? parsed.title,
    text: processed.text,
    filters: data.filters,
    teamId: data.teamId,
    workspaceId: data.workspaceId,
    knowledgeGroupId: data.knowledgeGroupId,
    userOwned: data.userOwned,
    sourceType: "url",
    sourceUrl: data.url,
    sourceFileBucket: "default",
    metadata: {
      ...(parsed.excerpt ? { excerpt: parsed.excerpt } : {}),
      ...(parsed.byline ? { byline: parsed.byline } : {}),
      ...(parsed.siteName ? { siteName: parsed.siteName } : {}),
    },
    includesLocalImages: false,
  });
};

/**
 * Extract knowledge from a plain text (with optional post-processing) and store
 * it as a knowledge entry.
 *
 * Extracted from the former synchronous `POST .../knowledge/from-text` route so
 * the exact same logic can now run inside a background job. Returns
 * `{ id, ok }` — the created knowledge entry id.
 */
export const extractKnowledgeFromPlainText = async (data: {
  tenantId: string;
  text: string;
  title: string;
  filters?: Record<string, string>;
  teamId?: string;
  userId?: string;
  workspaceId?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  meta?: { sourceUri: string; sourceId: string };
  usePostProcessors?: string[];
}) => {
  const processed = await applyPostProcessors(
    {
      text: data.text,
      title: data.title,
      source: { type: "text", includesImages: false },
      context: { tenantId: data.tenantId, userId: data.userId },
    },
    data.usePostProcessors
  );

  return extractKnowledgeFromText({
    userId: data.userId,
    tenantId: data.tenantId,
    title: processed.title ?? data.title,
    text: processed.text,
    filters: data.filters,
    teamId: data.teamId,
    workspaceId: data.workspaceId,
    knowledgeGroupId: data.knowledgeGroupId,
    userOwned: data.userOwned,
    sourceExternalId: data.meta?.sourceId ?? data.title,
    sourceType: "external",
    sourceFileBucket: "default",
    sourceUrl: data.meta?.sourceUri ?? data.title,
    includesLocalImages: false,
  });
};
