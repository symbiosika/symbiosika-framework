import { describe, test, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import { createKnowledgeText } from "./knowledge-texts";
import { getKnowledgeOverview } from "./knowledge-overview";

const TENANT = TEST_ORGANISATION_1.id;
const ctx = { tenantId: TENANT };

describe("wiki overview", () => {
  beforeAll(async () => {
    await initTests();
  });

  test("returns metrics, top-level structure and recent changes", async () => {
    const top = await createKnowledgeText({
      tenantId: TENANT,
      title: "Overview top-level",
      text: "top content",
    });
    await createKnowledgeText({
      tenantId: TENANT,
      title: "Overview child",
      text: "child content",
      parentId: top.id,
    });

    const overview = await getKnowledgeOverview(ctx);
    expect(overview.metrics.totalPages).toBeGreaterThanOrEqual(2);
    expect(overview.metrics.topLevelCount).toBeGreaterThanOrEqual(1);
    expect(overview.metrics.lastActivityAt).not.toBeNull();
    // top-level items must not include the child page
    const topIds = overview.topLevel.map((p) => p.id);
    expect(topIds).toContain(top.id);
    // top-level items carry summaries (delivered everywhere)
    expect(overview.topLevel[0]).toHaveProperty("summary");
    expect(overview.recentChanges.length).toBeGreaterThanOrEqual(1);
  });

  test("embeds the agent-instructions page when one is flagged", async () => {
    const instr = await createKnowledgeText({
      tenantId: TENANT,
      title: "Agent Instructions",
      text: "Where things live and how to name pages.",
      tenantWide: true,
    });
    await getDb()
      .update(knowledgeText)
      .set({ isAgentInstructions: true })
      .where(eq(knowledgeText.id, instr.id));

    const overview = await getKnowledgeOverview(ctx);
    expect(overview.agentInstructions).not.toBeNull();
    expect(overview.agentInstructions?.id).toBe(instr.id);
    expect(overview.agentInstructions?.content).toContain("Where things live");
  });
});
