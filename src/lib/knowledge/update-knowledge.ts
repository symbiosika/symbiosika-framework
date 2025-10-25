import { getDb } from "../db/db-connection";
import { eq } from "drizzle-orm";
import { knowledgeEntry } from "../db/schema/knowledge";
import { isUserPartOfTeam } from "../usermanagement/teams";
import { validateKnowledgeAccess } from "./permissions";

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
