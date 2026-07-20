/**
 * The "CLAUDE.md of the wiki": a curated entry point plus an auto-generated
 * overview, so an agent starts a session briefed rather than exploring blind.
 *
 * getWikiOverview returns, all within the caller's visibility:
 *   - metrics: page count, number of top-level areas, last activity
 *   - top-level structure WITH summaries and facets
 *   - the most recently changed pages (reuses the recent-changes helper)
 *   - the tenant's agent-instructions page (flagged via isAgentInstructions),
 *     with its content embedded so it can be loaded in one call
 */

import { and, count, desc, eq, isNull, max, getTableColumns } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import { buildKnowledgeTextVisibilityConditions } from "./knowledge-texts";
import { listRecentChanges } from "./knowledge-text-agent";

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

export interface WikiOverview {
  metrics: {
    totalPages: number;
    topLevelCount: number;
    lastActivityAt: string | null;
  };
  topLevel: Record<string, unknown>[];
  recentChanges: Record<string, unknown>[];
  agentInstructions: { id: string; title: string; content: string } | null;
}

const listColumns = () => {
  const { text, ...rest } = getTableColumns(knowledgeText);
  return rest;
};

export const getWikiOverview = async (
  context: Context,
  options: { recentLimit?: number } = {}
): Promise<WikiOverview> => {
  const visibility = buildKnowledgeTextVisibilityConditions(context);

  const [metricsRow] = await getDb()
    .select({
      totalPages: count(),
      lastActivityAt: max(knowledgeText.updatedAt),
    })
    .from(knowledgeText)
    .where(and(...visibility));

  // Top-level pages (no parent), with summaries + facets, in wiki order.
  const topLevel = await getDb()
    .select(listColumns())
    .from(knowledgeText)
    .where(and(...visibility, isNull(knowledgeText.parentId)))
    .orderBy(knowledgeText.position, knowledgeText.title);

  const recentChanges = await listRecentChanges(context, {
    limit: options.recentLimit ?? 10,
  });

  // Agent-instructions page: prefer a tenant-wide one (teamId null), else any
  // visible flagged page. Content is embedded so a session can load it at once.
  const instructionsRows = await getDb()
    .select({
      id: knowledgeText.id,
      title: knowledgeText.title,
      content: knowledgeText.text,
      teamId: knowledgeText.teamId,
    })
    .from(knowledgeText)
    .where(and(...visibility, eq(knowledgeText.isAgentInstructions, true)))
    .orderBy(knowledgeText.teamId, desc(knowledgeText.updatedAt));

  const preferred =
    instructionsRows.find((r) => r.teamId === null) ?? instructionsRows[0];

  return {
    metrics: {
      totalPages: Number(metricsRow?.totalPages ?? 0),
      topLevelCount: topLevel.length,
      lastActivityAt: metricsRow?.lastActivityAt ?? null,
    },
    topLevel,
    recentChanges,
    agentInstructions: preferred
      ? { id: preferred.id, title: preferred.title, content: preferred.content }
      : null,
  };
};
