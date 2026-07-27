import { describe, test, expect, beforeAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  initTests,
  TEST_ORGANISATION_2,
  TEST_ORG2_USER_1,
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { knowledgeText } from "../db/schema/knowledge";
import { createKnowledgeText, getKnowledgeText } from "./knowledge-texts";
import { updateTenantMemberKnowledgeAccess } from "../usermanagement/tenants";
import { getKnowledgeOverview } from "./knowledge-overview";
import {
  AGENT_INSTRUCTIONS_DEFAULT_TITLE,
  readAgentInstructions,
  saveAgentInstructions,
  deleteAgentInstructions,
} from "./knowledge-agent-instructions";

// Own tenant: the overview asserts on "the" instructions page, so this must
// not race with the flagged page created by knowledge-overview.test.ts.
const TENANT = TEST_ORGANISATION_2.id;

describe("agent instructions", () => {
  beforeAll(async () => {
    await initTests();
    await deleteAgentInstructions(TENANT);
  });

  test("is null before anything was saved", async () => {
    expect(await readAgentInstructions(TENANT)).toBeNull();
  });

  test("creates the page on first save, updates it afterwards", async () => {
    const created = await saveAgentInstructions(TENANT, {
      content: "Always cite the page title.",
    });
    expect(created.title).toBe(AGENT_INSTRUCTIONS_DEFAULT_TITLE);
    expect(created.content).toBe("Always cite the page title.");

    const updated = await saveAgentInstructions(TENANT, {
      content: "Always cite the page title and its id.",
    });
    // same page, not a second one
    expect(updated.id).toBe(created.id);
    expect(updated.content).toContain("and its id");

    const rows = await getDb()
      .select()
      .from(knowledgeText)
      .where(
        and(
          eq(knowledgeText.tenantId, TENANT),
          eq(knowledgeText.isAgentInstructions, true)
        )
      );
    expect(rows.length).toBe(1);
    expect(rows[0]?.hidden).toBe(true);
    expect(rows[0]?.tenantWide).toBe(true);
    expect(rows[0]?.teamId).toBeNull();
    // hidden page must never be mirrored into the RAG index
    expect(rows[0]?.embeddingEnabled).toBe(false);
  });

  test("stays out of the normal page listing but reaches the overview", async () => {
    const saved = await saveAgentInstructions(TENANT, {
      content: "House rules for agents.",
    });

    const listed = await getKnowledgeText({ tenantId: TENANT });
    expect(listed.map((p) => p.id)).not.toContain(saved.id);

    const overview = await getKnowledgeOverview({ tenantId: TENANT });
    expect(overview.agentInstructions?.id).toBe(saved.id);
    expect(overview.agentInstructions?.content).toBe("House rules for agents.");
    // and it must not pad the visible structure
    expect(overview.topLevel.map((p) => p.id)).not.toContain(saved.id);
  });

  test("keeps a single organisation-wide page when another one is flagged", async () => {
    const saved = await saveAgentInstructions(TENANT, { content: "canonical" });

    // a stray second flagged page, e.g. set by hand before this UI existed
    const stray = await createKnowledgeText({
      tenantId: TENANT,
      title: "Old instructions",
      text: "outdated",
      tenantWide: true,
      isAgentInstructions: true,
    });

    await saveAgentInstructions(TENANT, { content: "canonical again" });

    const [strayRow] = await getDb()
      .select({ flag: knowledgeText.isAgentInstructions })
      .from(knowledgeText)
      .where(eq(knowledgeText.id, stray.id));
    expect(strayRow?.flag).toBe(false);

    const overview = await getKnowledgeOverview({ tenantId: TENANT });
    expect(overview.agentInstructions?.id).toBe(saved.id);
  });

  test("rejects a member with read-only knowledge access", async () => {
    await updateTenantMemberKnowledgeAccess(
      TENANT,
      TEST_ORG2_USER_1.id,
      "read"
    );
    expect(
      saveAgentInstructions(
        TENANT,
        { content: "nope" },
        { userId: TEST_ORG2_USER_1.id }
      )
    ).rejects.toThrow();

    await updateTenantMemberKnowledgeAccess(
      TENANT,
      TEST_ORG2_USER_1.id,
      "write"
    );
    const saved = await saveAgentInstructions(
      TENANT,
      { content: "allowed now" },
      { userId: TEST_ORG2_USER_1.id }
    );
    expect(saved.content).toBe("allowed now");
    expect(saved.updatedBy).toBe(TEST_ORG2_USER_1.id);
  });

  test("delete removes the page and reports whether there was one", async () => {
    await saveAgentInstructions(TENANT, { content: "to be removed" });
    expect(await deleteAgentInstructions(TENANT)).toBe(true);
    expect(await readAgentInstructions(TENANT)).toBeNull();
    expect(await deleteAgentInstructions(TENANT)).toBe(false);
  });
});
