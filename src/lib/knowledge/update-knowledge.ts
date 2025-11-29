import { getDb } from "../db/db-connection";
import { eq } from "drizzle-orm";
import { knowledgeEntry, knowledgeChunks } from "../db/schema/knowledge";
import { isUserPartOfTeam } from "../usermanagement/teams";
import { validateKnowledgeAccess } from "./permissions";
import { splitTextIntoSectionsOrChunks } from "./splitter";
import { generateEmbedding } from "./embedding";
import type { ChunkWithEmbedding } from "../types/chunks";
import type { KnowledgeChunksInsert } from "../db/schema/knowledge";
import log from "../log";

/**
 * Delete a knowledge entry by ID
 * will check if the user has permission to delete the knowledge entry
 */
export const deleteKnowledgeEntry = async (
  id: string,
  tenantId: string,
  userId: string
) => {
  // check the user permissions
  const canDelete = await validateKnowledgeAccess(id, userId, tenantId);
  if (!canDelete) {
    throw new Error(
      "User does not have permission to delete this knowledge entry"
    );
  }

  await getDb().delete(knowledgeEntry).where(eq(knowledgeEntry.id, id));
};

/**
 * Update a knowledge entry by ID
 * Only the name can be updated
 */
export const updateKnowledgeEntry = async (
  id: string,
  tenantId: string,
  userId: string,
  data: {
    name?: string | undefined;
    teamId?: string | null;
    knowledgeGroupId?: string | null;
    userOwned?: boolean;
    description?: string | null;
  }
) => {
  const canUpdate = await validateKnowledgeAccess(id, userId, tenantId);
  if (!canUpdate) {
    throw new Error(
      "User does not have permission to update this knowledge entry"
    );
  }

  // is a new teamId provided?
  if (data.teamId) {
    const isPartOfTeam = await isUserPartOfTeam(userId, data.teamId);
    if (!isPartOfTeam) {
      throw new Error("User is not part of the provided team");
    }
  }

  const r = await getDb()
    .update(knowledgeEntry)
    .set(data)
    .where(eq(knowledgeEntry.id, id))
    .returning();

  return r[0];
};

/**
 * Helper to store a knowledge chunk in the database
 */
const storeKnowledgeChunk = async (data: KnowledgeChunksInsert) => {
  const db = getDb();
  const [chunk] = await db.insert(knowledgeChunks).values(data).returning();
  if (!chunk) {
    throw new Error("Error storing knowledge chunk");
  }
  return chunk;
};

/**
 * Update the text content of a knowledge entry and recreate all chunks
 * This will delete all existing chunks and create new ones with fresh embeddings
 */
export const updateKnowledgeEntryText = async (
  id: string,
  tenantId: string,
  userId: string,
  text: string
) => {
  // Check user permissions first
  const canUpdate = await validateKnowledgeAccess(id, userId, tenantId);
  if (!canUpdate) {
    throw new Error(
      "User does not have permission to update this knowledge entry"
    );
  }

  // Get the existing entry to preserve metadata
  const existingEntry = await getDb()
    .query.knowledgeEntry.findFirst({
      where: eq(knowledgeEntry.id, id),
    });

  if (!existingEntry) {
    throw new Error("Knowledge entry not found");
  }

  // Delete all existing chunks
  await getDb()
    .delete(knowledgeChunks)
    .where(eq(knowledgeChunks.knowledgeEntryId, id));

  log.debug(`Deleted existing chunks for knowledge entry: ${id}`);

  // Split the new text into chunks
  const chunks = splitTextIntoSectionsOrChunks(text);

  // Generate embeddings for all chunks
  const allEmbeddings: ChunkWithEmbedding[] = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const embedding = await generateEmbedding(chunk.text, {
          tenantId,
          userId,
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

  log.debug(`Generated embeddings. Chunks: ${chunks.length}`);

  // Store the new chunks in the database
  await Promise.all(
    allEmbeddings.map((e) => {
      return storeKnowledgeChunk({
        knowledgeEntryId: id,
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

  log.debug(`Stored ${allEmbeddings.length} new chunks for knowledge entry: ${id}`);

  // Update the entry's updatedAt timestamp
  const updatedEntry = await getDb()
    .update(knowledgeEntry)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(knowledgeEntry.id, id))
    .returning();

  return updatedEntry[0];
};
