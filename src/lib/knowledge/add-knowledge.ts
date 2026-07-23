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
import { assignBlockProvenance, type BlockSpan } from "./block-provenance";
import type { ChunkWithEmbedding } from "../types/chunks";
import {
  knowledgeChunks,
  knowledgeEntry,
  type KnowledgeChunksInsert,
  type KnowledgeEntryInsert,
} from "../db/schema/knowledge";
import type { PageContent } from "./parsing/pdf/types";
import { generateEmbedding } from "./embedding";
import { generateEntryDescription } from "./entry-summaries";

/**
 * Helper function to store a knowledge entry in the database
 */
export const storeKnowledgeEntry = async (data: KnowledgeEntryInsert) => {
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
  userOwned?: boolean;
  includesLocalImages?: boolean;
  generateSummary?: boolean;
  summaryCustomPrompt?: string;
  summaryModel?: string;
  /**
   * Character spans of the source content blocks inside `text`, in order.
   * When given, each chunk is tagged with the id of the block it starts in
   * (`chunk.meta.blockId`) so retrieval hits can deep-link back to the exact
   * block. Only meaningful for block-mode wiki pages; ignored for `pages`
   * (PDF) input, which has its own page provenance.
   */
  blockSpans?: BlockSpan[];
}) => {
  const title = data.title;

  // Get full text for text-based operations
  let fullText = data.text || "";
  if (!data.text && data.pages) {
    fullText = data.pages.map((page) => page.text).join("\n\n");
  }

  // Split the content into chunks - now handles both text and pages
  const chunks = splitDocumentIntoChunks(data.pages || fullText);

  // Tag chunks with their source block (wiki block-mode pages). Text-based
  // only: `pages` input carries page provenance instead. No effect on chunk
  // boundaries or text — purely additive metadata.
  if (!data.pages && data.blockSpans && data.blockSpans.length > 0) {
    assignBlockProvenance(chunks, fullText, data.blockSpans);
  }

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

  // Generate the entry description if requested. Skipped without a global
  // LLM; a failed generation stores the entry without a description.
  let description: string | undefined = undefined;

  if (data.generateSummary ?? true) {
    log.debug(`Generating description for knowledge entry: ${title}`);
    description = await generateEntryDescription({
      title,
      fullText,
      chunks,
      model: data.summaryModel,
      customPrompt: data.summaryCustomPrompt,
    });
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
      userOwned: data.userOwned,
      description,
    }
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
        dimensions: e.embedding.dimensions,
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
