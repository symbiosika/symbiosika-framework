import { describe, test, expect, beforeAll } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { createKnowledgeText } from "./knowledge-texts";
import { getKnowledgeOverview } from "./knowledge-overview";
import { saveAgentInstructions } from "./knowledge-agent-instructions";

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

  test("embeds the tenant's agent instructions when configured", async () => {
    await saveAgentInstructions(TENANT, {
      content: "Where things live and how to name pages.",
    });

    const overview = await getKnowledgeOverview(ctx);
    expect(overview.agentInstructions).not.toBeNull();
    expect(overview.agentInstructions?.content).toContain("Where things live");
  });
});
