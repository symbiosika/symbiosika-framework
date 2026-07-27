/**
 * The tenant's agent instructions — the "CLAUDE.md of the knowledge base".
 *
 * Curated orientation handed to every agent at the start of a session (see
 * knowledge-overview.ts): what lives where, naming conventions, which areas
 * are authoritative, house rules.
 *
 * One row per tenant in `knowledge_agent_instructions`, enforced by a unique
 * constraint. Absence of the row means "this organisation has no instructions"
 * — an empty `content` is the distinct, deliberate state of "configured, then
 * cleared".
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeAgentInstructions } from "../db/schema/knowledge";
import type { KnowledgeAgentInstructionsSelect } from "../db/schema/knowledge";
import { checkTenantKnowledgeWriteAccess } from "../usermanagement/tenants";

export interface AgentInstructions {
  content: string;
  updatedAt: string;
  updatedBy: string | null;
}

const toResult = (
  row: KnowledgeAgentInstructionsSelect
): AgentInstructions => ({
  content: row.content,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

/**
 * Read a tenant's agent instructions, or null when none are configured.
 *
 * Callers are responsible for the tenant membership check (the routes do it).
 */
export const readAgentInstructions = async (
  tenantId: string
): Promise<AgentInstructions | null> => {
  const rows = await getDb()
    .select()
    .from(knowledgeAgentInstructions)
    .where(eq(knowledgeAgentInstructions.tenantId, tenantId))
    .limit(1);

  return rows[0] ? toResult(rows[0]) : null;
};

/**
 * Create or replace a tenant's agent instructions.
 *
 * Requires tenant-wide knowledge WRITE access — organisation-wide agent
 * behaviour is not something a read-only member may change. Service calls
 * without a userId skip the check, consistent with the rest of the knowledge
 * layer.
 *
 * Upsert on the tenant's unique constraint, so two admins saving at the same
 * time cannot end up creating two rows.
 */
export const saveAgentInstructions = async (
  tenantId: string,
  data: { content: string },
  context: { userId?: string } = {}
): Promise<AgentInstructions> => {
  if (context.userId) {
    await checkTenantKnowledgeWriteAccess(tenantId, context.userId);
  }

  const result = await getDb()
    .insert(knowledgeAgentInstructions)
    .values({
      tenantId,
      content: data.content,
      updatedBy: context.userId ?? null,
    })
    .onConflictDoUpdate({
      target: knowledgeAgentInstructions.tenantId,
      set: {
        content: data.content,
        updatedBy: context.userId ?? null,
        updatedAt: new Date().toISOString(),
      },
    })
    .returning();

  if (!result[0]) {
    throw new Error("Failed to save the agent instructions");
  }
  return toResult(result[0]);
};

/**
 * Remove a tenant's agent instructions. Returns false when there were none.
 */
export const deleteAgentInstructions = async (
  tenantId: string,
  context: { userId?: string } = {}
): Promise<boolean> => {
  if (context.userId) {
    await checkTenantKnowledgeWriteAccess(tenantId, context.userId);
  }

  const deleted = await getDb()
    .delete(knowledgeAgentInstructions)
    .where(eq(knowledgeAgentInstructions.tenantId, tenantId))
    .returning();

  return deleted.length > 0;
};
