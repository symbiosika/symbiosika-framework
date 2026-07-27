import { describe, test, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import {
  initTests,
  TEST_ORGANISATION_2,
  TEST_ORG2_USER_1,
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { knowledgeAgentInstructions } from "../db/schema/knowledge";
import { updateTenantMemberKnowledgeAccess } from "../usermanagement/tenants";
import { getKnowledgeOverview } from "./knowledge-overview";
import {
  readAgentInstructions,
  saveAgentInstructions,
  deleteAgentInstructions,
} from "./knowledge-agent-instructions";

// Own tenant so the overview assertions are not disturbed by the fixtures of
// the other knowledge tests.
const TENANT = TEST_ORGANISATION_2.id;

describe("agent instructions", () => {
  beforeAll(async () => {
    await initTests();
    await deleteAgentInstructions(TENANT);
  });

  test("is null before anything was saved", async () => {
    expect(await readAgentInstructions(TENANT)).toBeNull();
    const overview = await getKnowledgeOverview({ tenantId: TENANT });
    expect(overview.agentInstructions).toBeNull();
  });

  test("saves once and updates in place, never creating a second row", async () => {
    const created = await saveAgentInstructions(TENANT, {
      content: "Always cite the page title.",
    });
    expect(created.content).toBe("Always cite the page title.");

    const updated = await saveAgentInstructions(TENANT, {
      content: "Always cite the page title and its id.",
    });
    expect(updated.content).toContain("and its id");

    const rows = await getDb()
      .select()
      .from(knowledgeAgentInstructions)
      .where(eq(knowledgeAgentInstructions.tenantId, TENANT));
    expect(rows.length).toBe(1);
  });

  test("is delivered by the knowledge overview", async () => {
    await saveAgentInstructions(TENANT, { content: "House rules for agents." });

    const overview = await getKnowledgeOverview({ tenantId: TENANT });
    expect(overview.agentInstructions?.content).toBe("House rules for agents.");
    expect(overview.agentInstructions?.updatedAt).toBeTruthy();
  });

  test("empty content is stored but reads as no briefing in the overview", async () => {
    await saveAgentInstructions(TENANT, { content: "" });

    // the row still exists — the organisation configured and then cleared it
    expect(await readAgentInstructions(TENANT)).not.toBeNull();
    // ...but an agent must not be handed an empty instruction block
    const overview = await getKnowledgeOverview({ tenantId: TENANT });
    expect(overview.agentInstructions).toBeNull();
  });

  test("records who last changed them", async () => {
    const saved = await saveAgentInstructions(
      TENANT,
      { content: "attributed" },
      { userId: TEST_ORG2_USER_1.id }
    );
    expect(saved.updatedBy).toBe(TEST_ORG2_USER_1.id);
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
    expect(
      deleteAgentInstructions(TENANT, { userId: TEST_ORG2_USER_1.id })
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
  });

  test("delete removes the row and reports whether there was one", async () => {
    await saveAgentInstructions(TENANT, { content: "to be removed" });
    expect(await deleteAgentInstructions(TENANT)).toBe(true);
    expect(await readAgentInstructions(TENANT)).toBeNull();
    expect(await deleteAgentInstructions(TENANT)).toBe(false);
  });
});
