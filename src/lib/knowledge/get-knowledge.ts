import { getDb } from "../db/db-connection";
import { and, eq } from "drizzle-orm";
import { knowledgeChunks, knowledgeEntry } from "../db/schema/knowledge";
import { validateKnowledgeAccess } from "./permissions";

/**
 * Get the full plain source text/documents for a knowledge entry id
 * Is used in the UI to display the full source text/documents for a knowledge entry
 */
export const getFullSourceDocumentsForKnowledgeEntry = async (
  id: string,
  tenantId: string,
  userId: string
) => {
  // Check user permissions first
  const hasAccess = await validateKnowledgeAccess(id, userId, tenantId);
  if (!hasAccess) {
    throw new Error(
      "User does not have permission to access this knowledge entry"
    );
  }

  const entry = await getDb().query.knowledgeEntry.findFirst({
    where: and(
      eq(knowledgeEntry.id, id),
      eq(knowledgeEntry.tenantId, tenantId)
    ),
  });
  const chunks = await getDb().query.knowledgeChunks.findMany({
    where: eq(knowledgeChunks.knowledgeEntryId, id),
    orderBy: (knowledgeChunks, { asc }) => [asc(knowledgeChunks.order)],
  });
  const text = chunks.map((chunk) => chunk.text).join("\n");
  return {
    entry,
    text,
  };
};
