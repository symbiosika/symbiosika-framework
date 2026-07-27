/**
 * The "CLAUDE.md of the knowledge base": a curated entry point plus an auto-generated
 * overview, so an agent starts a session briefed rather than exploring blind.
 *
 * getKnowledgeOverview returns, all within the caller's visibility:
 *   - metrics: page count, number of top-level areas, last activity
 *   - top-level structure WITH summaries and facets
 *   - the most recently changed pages (reuses the recent-changes helper)
 *   - the tenant's agent instructions, embedded so a session can load the
 *     whole briefing in one call
 */

import { and, count, isNull, max, getTableColumns } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import { buildKnowledgeTextVisibilityConditions } from "./knowledge-texts";
import { listRecentChanges } from "./knowledge-text-agent";
import { readAgentInstructions } from "./knowledge-agent-instructions";

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

export interface KnowledgeOverview {
  metrics: {
    totalPages: number;
    topLevelCount: number;
    lastActivityAt: string | null;
  };
  topLevel: Record<string, unknown>[];
  recentChanges: Record<string, unknown>[];
  /** Null when the tenant configured none, or cleared them to empty. */
  agentInstructions: { content: string; updatedAt: string } | null;
}

const listColumns = () => {
  const { text, ...rest } = getTableColumns(knowledgeText);
  return rest;
};

export const getKnowledgeOverview = async (
  context: Context,
  options: { recentLimit?: number } = {}
): Promise<KnowledgeOverview> => {
  const visibility = buildKnowledgeTextVisibilityConditions(context);

  const [metricsRow] = await getDb()
    .select({
      totalPages: count(),
      lastActivityAt: max(knowledgeText.updatedAt),
    })
    .from(knowledgeText)
    .where(and(...visibility));

  // Top-level pages (no parent), with summaries + facets, in tree order.
  const topLevel = await getDb()
    .select(listColumns())
    .from(knowledgeText)
    .where(and(...visibility, isNull(knowledgeText.parentId)))
    .orderBy(knowledgeText.position, knowledgeText.title);

  const recentChanges = await listRecentChanges(context, {
    limit: options.recentLimit ?? 10,
  });

  // The organisation's agent instructions, embedded so a session can load the
  // whole briefing in one call. Tenant-scoped configuration, not a page, so it
  // is unaffected by the caller's page visibility.
  const instructions = await readAgentInstructions(context.tenantId);

  return {
    metrics: {
      totalPages: Number(metricsRow?.totalPages ?? 0),
      topLevelCount: topLevel.length,
      lastActivityAt: metricsRow?.lastActivityAt ?? null,
    },
    topLevel,
    recentChanges,
    agentInstructions: instructions?.content
      ? { content: instructions.content, updatedAt: instructions.updatedAt }
      : null,
  };
};
