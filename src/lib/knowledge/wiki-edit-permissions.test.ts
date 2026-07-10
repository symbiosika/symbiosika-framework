import { describe, it, expect, beforeAll } from "bun:test";
import {
  createKnowledgeText,
  updateKnowledgeText,
} from "./knowledge-texts";
import {
  getWikiEditPolicy,
  setWikiEditPolicy,
  DEFAULT_WIKI_EDIT_POLICY,
  assertCanWriteKnowledge,
} from "./permissions";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1, // owner of org 1
  TEST_ORG1_USER_2, // member of org 1
  TEST_ORG1_USER_3, // member of org 1
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { teams, teamMembers } from "../db/schema/users";
import { tenantSpecificData } from "../db/schema/additional-data";
import { addTeamMember } from "../usermanagement/teams";
import { eq } from "drizzle-orm";

const TEAM_ID = "00000000-3333-3333-3333-000000000099";

const resetPolicy = async () => {
  await getDb()
    .delete(tenantSpecificData)
    .where(eq(tenantSpecificData.tenantId, TEST_ORGANISATION_1.id));
};

describe("Wiki edit permissions (configurable per tenant)", () => {
  beforeAll(async () => {
    await initTests();

    // Create a team inside org 1 with USER_1 as admin and USER_2 as member
    await getDb().delete(teams).where(eq(teams.id, TEAM_ID));
    await getDb().insert(teams).values({
      id: TEAM_ID,
      name: "Wiki Test Team",
      tenantId: TEST_ORGANISATION_1.id,
    });
    await getDb()
      .delete(teamMembers)
      .where(eq(teamMembers.teamId, TEAM_ID));
    await addTeamMember(
      TEAM_ID,
      TEST_ORGANISATION_1.id,
      TEST_ORG1_USER_1.id,
      "admin"
    );
    await addTeamMember(
      TEAM_ID,
      TEST_ORGANISATION_1.id,
      TEST_ORG1_USER_2.id,
      "member"
    );
  });

  describe("policy storage", () => {
    it("returns the default (admins only) policy when nothing is configured", async () => {
      await resetPolicy();
      const policy = await getWikiEditPolicy(TEST_ORGANISATION_1.id);
      expect(policy).toEqual(DEFAULT_WIKI_EDIT_POLICY);
    });

    it("persists and reads back a custom policy (upsert)", async () => {
      await setWikiEditPolicy(TEST_ORGANISATION_1.id, {
        tenantWide: "members",
        team: "team-members",
      });
      let policy = await getWikiEditPolicy(TEST_ORGANISATION_1.id);
      expect(policy).toEqual({ tenantWide: "members", team: "team-members" });

      // upsert again with a different value
      await setWikiEditPolicy(TEST_ORGANISATION_1.id, {
        tenantWide: "admins",
        team: "team-admins",
      });
      policy = await getWikiEditPolicy(TEST_ORGANISATION_1.id);
      expect(policy).toEqual(DEFAULT_WIKI_EDIT_POLICY);
    });
  });

  describe("tenant-wide wiki content", () => {
    it("allows an owner/admin to edit by default", async () => {
      await resetPolicy();
      const text = await createKnowledgeText({
        title: "Org wide - owner",
        text: "content",
        tenantId: TEST_ORGANISATION_1.id,
        tenantWide: true,
        userId: TEST_ORG1_USER_1.id,
      });
      const updated = await updateKnowledgeText(
        text.id,
        { text: "changed by owner" },
        { tenantId: TEST_ORGANISATION_1.id, userId: TEST_ORG1_USER_1.id }
      );
      expect(updated.text).toBe("changed by owner");
    });

    it("forbids a plain member from editing under the default policy", async () => {
      await resetPolicy();
      const text = await createKnowledgeText({
        title: "Org wide - default",
        text: "content",
        tenantId: TEST_ORGANISATION_1.id,
        tenantWide: true,
        userId: TEST_ORG1_USER_1.id,
      });

      await expect(
        updateKnowledgeText(
          text.id,
          { text: "member edit attempt" },
          { tenantId: TEST_ORGANISATION_1.id, userId: TEST_ORG1_USER_2.id }
        )
      ).rejects.toThrow();
    });

    it("lets any member edit once the policy is set to 'members'", async () => {
      await setWikiEditPolicy(TEST_ORGANISATION_1.id, {
        tenantWide: "members",
        team: "team-admins",
      });
      const text = await createKnowledgeText({
        title: "Org wide - members policy",
        text: "content",
        tenantId: TEST_ORGANISATION_1.id,
        tenantWide: true,
        userId: TEST_ORG1_USER_1.id,
      });

      const updated = await updateKnowledgeText(
        text.id,
        { text: "member edit allowed" },
        { tenantId: TEST_ORGANISATION_1.id, userId: TEST_ORG1_USER_2.id }
      );
      expect(updated.text).toBe("member edit allowed");
      await resetPolicy();
    });
  });

  describe("team wiki content", () => {
    it("forbids a team member from editing under the default policy", async () => {
      await resetPolicy();
      const text = await createKnowledgeText({
        title: "Team text - default",
        text: "content",
        tenantId: TEST_ORGANISATION_1.id,
        teamId: TEAM_ID,
        userId: TEST_ORG1_USER_1.id, // team admin
      });

      await expect(
        updateKnowledgeText(
          text.id,
          { text: "team member edit attempt" },
          { tenantId: TEST_ORGANISATION_1.id, userId: TEST_ORG1_USER_2.id }
        )
      ).rejects.toThrow();
    });

    it("lets a team member edit once the policy is set to 'team-members'", async () => {
      await setWikiEditPolicy(TEST_ORGANISATION_1.id, {
        tenantWide: "admins",
        team: "team-members",
      });
      const text = await createKnowledgeText({
        title: "Team text - team-members policy",
        text: "content",
        tenantId: TEST_ORGANISATION_1.id,
        teamId: TEAM_ID,
        userId: TEST_ORG1_USER_1.id,
      });

      const updated = await updateKnowledgeText(
        text.id,
        { text: "team member edit allowed" },
        { tenantId: TEST_ORGANISATION_1.id, userId: TEST_ORG1_USER_2.id }
      );
      expect(updated.text).toBe("team member edit allowed");
      await resetPolicy();
    });
  });

  describe("assertCanWriteKnowledge resolver", () => {
    it("is a no-op when there is no acting user (server-to-server)", async () => {
      // Should resolve without throwing even for tenant-wide content.
      await assertCanWriteKnowledge(
        {
          tenantId: TEST_ORGANISATION_1.id,
          tenantWide: true,
          teamId: null,
          userId: null,
        },
        { userId: undefined, tenantId: TEST_ORGANISATION_1.id }
      );
      expect(true).toBe(true);
    });

    it("always lets the owner edit personal content", async () => {
      await resetPolicy();
      // personal (not tenant-wide, no team) owned by USER_3
      await assertCanWriteKnowledge(
        {
          tenantId: TEST_ORGANISATION_1.id,
          tenantWide: false,
          teamId: null,
          userId: TEST_ORG1_USER_3.id,
        },
        { userId: TEST_ORG1_USER_3.id, tenantId: TEST_ORGANISATION_1.id }
      );
      expect(true).toBe(true);
    });
  });
});
