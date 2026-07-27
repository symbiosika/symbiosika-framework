/**
 * The tenant's agent-instructions page — the "CLAUDE.md of the knowledge base".
 *
 * It is a perfectly normal knowledgeText page, but managed from the admin UI
 * rather than the wiki tree, so it carries three deliberate properties:
 *
 *   - `isAgentInstructions: true` — this is the identity. Lookup goes through
 *     the flag, never through the title, so renaming the page (or a second
 *     page happening to share its title) cannot break the binding.
 *   - `hidden: true` — it must not appear in the tree, search, recent changes
 *     or the public view. `buildKnowledgeTextVisibilityConditions` filters
 *     hidden pages out everywhere unless `includeHidden` is passed; the
 *     knowledge overview asks for it explicitly for exactly this query.
 *   - `tenantWide: true`, `teamId: null` — organisation scope. The data model
 *     also allows a per-team page as an override; this module only manages the
 *     organisation-wide one.
 *
 * Writes go through createKnowledgeText/updateKnowledgeText rather than hitting
 * the table, so history, audit fields and the outgoing webhooks behave exactly
 * as they do for any other page — editing the instructions is versioned.
 */

import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import type { KnowledgeTextSelect } from "../db/schema/knowledge";
import {
  createKnowledgeText,
  updateKnowledgeText,
  deleteKnowledgeText,
} from "./knowledge-texts";
import { checkTenantKnowledgeWriteAccess } from "../usermanagement/tenants";

/** Default title of a freshly created page. Purely cosmetic — see module doc. */
export const AGENT_INSTRUCTIONS_DEFAULT_TITLE = "AgentInstructions";

export interface AgentInstructionsPage {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  updatedBy: string | null;
}

const toResult = (page: KnowledgeTextSelect): AgentInstructionsPage => ({
  id: page.id,
  title: page.title,
  content: page.text,
  updatedAt: page.updatedAt,
  updatedBy: page.updatedBy,
});

/**
 * Find the MANAGED organisation-wide agent-instructions page, or null.
 *
 * "Managed" is the three-way match flagged + hidden + teamId null. Hidden is
 * part of the identity on purpose: a tenant may also have flagged an ordinary,
 * visible wiki page by hand (that is all the flag meant before this UI
 * existed). Such a page must NOT be adopted here — adopting it would hide a
 * real page out from under its readers. It keeps existing as a normal page and
 * only loses the flag, which saveAgentInstructions clears so the overview has
 * one unambiguous source.
 *
 * Raw table read on purpose: the page is hidden, and this is an explicitly
 * scoped tenant lookup rather than a user-facing listing. Callers are
 * responsible for the tenant membership check (the routes do it).
 *
 * Still tolerates duplicates — the column has a partial index, not a unique
 * constraint — by picking the oldest, so repeated saves keep binding to the
 * same page instead of chasing whichever was touched last.
 */
export const getAgentInstructionsPage = async (
  tenantId: string
): Promise<KnowledgeTextSelect | null> => {
  const rows = await getDb()
    .select()
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.tenantId, tenantId),
        eq(knowledgeText.isAgentInstructions, true),
        eq(knowledgeText.hidden, true),
        isNull(knowledgeText.teamId)
      )
    )
    .orderBy(asc(knowledgeText.createdAt))
    .limit(1);

  return rows[0] ?? null;
};

/** Read shape for the API: null when the tenant has no instructions yet. */
export const readAgentInstructions = async (
  tenantId: string
): Promise<AgentInstructionsPage | null> => {
  const page = await getAgentInstructionsPage(tenantId);
  return page ? toResult(page) : null;
};

/**
 * Create or update the organisation-wide agent-instructions page.
 *
 * Requires tenant-wide knowledge WRITE access — org-wide agent behaviour is
 * not something a read-only member may change. Service calls without a userId
 * skip the check, consistent with the rest of the knowledge layer.
 */
export const saveAgentInstructions = async (
  tenantId: string,
  data: { content: string; title?: string },
  context: { userId?: string } = {}
): Promise<AgentInstructionsPage> => {
  if (context.userId) {
    await checkTenantKnowledgeWriteAccess(tenantId, context.userId);
  }

  const existing = await getAgentInstructionsPage(tenantId);

  if (existing) {
    const updated = await updateKnowledgeText(
      existing.id,
      {
        text: data.content,
        ...(data.title !== undefined ? { title: data.title } : {}),
        // re-assert the identity in case a flag drifted
        hidden: true,
        isAgentInstructions: true,
        tenantWide: true,
      },
      { tenantId, userId: context.userId, includeHidden: true }
    );
    await clearOtherAgentInstructionsFlags(tenantId, updated.id);
    return toResult(updated);
  }

  const created = await createKnowledgeText({
    tenantId,
    title: data.title?.trim() || AGENT_INSTRUCTIONS_DEFAULT_TITLE,
    text: data.content,
    tenantWide: true,
    teamId: null,
    parentId: null,
    hidden: true,
    isAgentInstructions: true,
    // Never mirror the page into the RAG pipeline: it is hidden precisely so
    // it stays out of search, and an embedded copy would put it right back in.
    embeddingEnabled: false,
    // No point spending an LLM call summarising a page that never appears in
    // a list — the summary would have nowhere to be shown.
    summaryMode: "off",
    createdBy: context.userId ?? null,
    updatedBy: context.userId ?? null,
  });

  await clearOtherAgentInstructionsFlags(tenantId, created.id);
  return toResult(created);
};

/**
 * Delete the tenant's agent instructions by clearing the flag and the page.
 * Returns false when there was nothing to remove.
 */
export const deleteAgentInstructions = async (
  tenantId: string,
  context: { userId?: string } = {}
): Promise<boolean> => {
  if (context.userId) {
    await checkTenantKnowledgeWriteAccess(tenantId, context.userId);
  }

  const existing = await getAgentInstructionsPage(tenantId);
  if (!existing) return false;

  // via the normal delete path so attached files/links are cleaned up too
  await deleteKnowledgeText(existing.id, {
    tenantId,
    userId: context.userId,
    includeHidden: true,
  });
  return true;
};

/**
 * Keep "one per organisation" true in practice: the schema only has a partial
 * index on the flag, so a second organisation-wide page could otherwise sit
 * around and win the overview's ordering. Team-scoped pages (teamId not null)
 * are legitimate overrides and stay untouched.
 */
const clearOtherAgentInstructionsFlags = async (
  tenantId: string,
  keepId: string
): Promise<void> => {
  await getDb()
    .update(knowledgeText)
    .set({ isAgentInstructions: false })
    .where(
      and(
        eq(knowledgeText.tenantId, tenantId),
        eq(knowledgeText.isAgentInstructions, true),
        isNull(knowledgeText.teamId),
        ne(knowledgeText.id, keepId)
      )
    );
};
