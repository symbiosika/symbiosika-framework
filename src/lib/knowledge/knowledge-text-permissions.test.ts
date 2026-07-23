import { describe, it, expect, beforeAll } from "bun:test";
import {
  createKnowledgeText,
  getKnowledgeTextById,
  updateKnowledgeText,
  deleteKnowledgeText,
  checkKnowledgeTextWritePermission,
} from "./knowledge-texts";
import { syncKnowledgeTextBlocks } from "./knowledge-text-blocks";
import { editKnowledgeTextContent } from "./knowledge-text-edit";
import {
  createTeam,
  addTeamMember,
  updateTeamMemberKnowledgeAccess,
  getTeamMemberKnowledgeAccess,
} from "../../lib/usermanagement/teams";
import {
  updateTenantMemberKnowledgeAccess,
  getTenantMemberKnowledgeAccess,
} from "../../lib/usermanagement/tenants";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1, // tenant owner
  TEST_ORG1_USER_2, // tenant member
  TEST_ORG1_USER_3, // tenant member
} from "../../test/init.test";

const TENANT = TEST_ORGANISATION_1.id;
const OWNER = TEST_ORG1_USER_1.id;
const MEMBER = TEST_ORG1_USER_2.id;
const OUTSIDER = TEST_ORG1_USER_3.id; // tenant member, but not in the team

let teamId: string;

const uniqueTitle = (name: string) => `${name} ${crypto.randomUUID()}`;

describe("Knowledge Text Permissions", () => {
  beforeAll(async () => {
    await initTests();
    const team = await createTeam({
      name: `Perm Test Team ${crypto.randomUUID()}`,
      tenantId: TENANT,
    });
    teamId = team.id;
    // MEMBER is a plain team member (not team admin)
    await addTeamMember(teamId, TENANT, MEMBER, "member");
  });

  describe("tenant-wide pages: every tenant member reads and writes", () => {
    it("a plain tenant member can update a tenant-wide page", async () => {
      const page = await createKnowledgeText({
        title: uniqueTitle("Org Page"),
        text: "org wide content",
        tenantId: TENANT,
        userId: OWNER,
        tenantWide: true,
      });

      // MEMBER has tenant role "member" — per spec that is enough to write
      const updated = await updateKnowledgeText(
        page.id,
        { text: "changed by plain member" },
        { tenantId: TENANT, userId: MEMBER }
      );
      expect(updated.text).toBe("changed by plain member");

      // block saves and string edits too
      const blockResult = await syncKnowledgeTextBlocks(
        page.id,
        [{ type: "markdown", content: "block content by member" }],
        { tenantId: TENANT, userId: MEMBER }
      );
      expect(blockResult.knowledgeText.text).toBe("block content by member");

      const edit = await editKnowledgeTextContent(
        page.id,
        { oldString: "by member", newString: "by plain member" },
        { tenantId: TENANT, userId: MEMBER }
      );
      expect(edit.replacements).toBe(1);
    });

    it("a plain tenant member can create and delete tenant-wide pages", async () => {
      const page = await createKnowledgeText({
        title: uniqueTitle("Member Created Org Page"),
        text: "content",
        tenantId: TENANT,
        userId: MEMBER,
        tenantWide: true,
      });
      expect(page.id).toBeDefined();

      // another plain member may delete it (tenant-wide = everyone writes)
      const result = await deleteKnowledgeText(page.id, {
        tenantId: TENANT,
        userId: OUTSIDER,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("team pages: every team member reads and writes", () => {
    it("a plain team member can create and write team pages", async () => {
      // MEMBER has team role "member" (not admin) — per spec that's enough
      const page = await createKnowledgeText({
        title: uniqueTitle("Team Page"),
        text: "team content",
        tenantId: TENANT,
        userId: MEMBER,
        teamId,
      });
      expect(page.teamId).toBe(teamId);

      const updated = await updateKnowledgeText(
        page.id,
        { text: "updated by team member" },
        { tenantId: TENANT, userId: MEMBER }
      );
      expect(updated.text).toBe("updated by team member");
    });

    it("a non-team-member can neither read nor write team pages", async () => {
      const page = await createKnowledgeText({
        title: uniqueTitle("Team Only Page"),
        text: "internal",
        tenantId: TENANT,
        userId: MEMBER,
        teamId,
      });

      // OUTSIDER is in the tenant but not in the team → page is invisible
      await expect(
        getKnowledgeTextById(page.id, { tenantId: TENANT, userId: OUTSIDER })
      ).rejects.toThrow();
      await expect(
        updateKnowledgeText(
          page.id,
          { text: "hacked" },
          { tenantId: TENANT, userId: OUTSIDER }
        )
      ).rejects.toThrow();
      await expect(
        syncKnowledgeTextBlocks(
          page.id,
          [{ type: "markdown", content: "hacked" }],
          { tenantId: TENANT, userId: OUTSIDER }
        )
      ).rejects.toThrow();
    });

    it("a non-team-member cannot create pages inside the team", async () => {
      await expect(
        createKnowledgeText({
          title: uniqueTitle("Sneaky Page"),
          text: "should fail",
          tenantId: TENANT,
          userId: OUTSIDER,
          teamId,
        })
      ).rejects.toThrow();
    });

    it("write check prefers team membership over the tenant-wide flag", async () => {
      // page assigned to a team AND flagged tenant-wide: reads are
      // team-scoped, so writes must be too
      await expect(
        checkKnowledgeTextWritePermission(
          {
            tenantId: TENANT,
            tenantWide: true,
            teamId,
            userId: null,
          },
          { tenantId: TENANT, userId: OUTSIDER }
        )
      ).rejects.toThrow();
    });
  });

  describe("personal pages: the assigned user always reads and writes", () => {
    it("the owner can always write, others cannot even see the page", async () => {
      const page = await createKnowledgeText({
        title: uniqueTitle("Private Page"),
        text: "my notes",
        tenantId: TENANT,
        userId: MEMBER,
      });

      const updated = await updateKnowledgeText(
        page.id,
        { text: "my updated notes" },
        { tenantId: TENANT, userId: MEMBER }
      );
      expect(updated.text).toBe("my updated notes");

      await expect(
        getKnowledgeTextById(page.id, { tenantId: TENANT, userId: OUTSIDER })
      ).rejects.toThrow();
      await expect(
        deleteKnowledgeText(page.id, { tenantId: TENANT, userId: OUTSIDER })
      ).rejects.toThrow();
    });

    it("the owner of a team page keeps write access (owner rule)", async () => {
      const page = await createKnowledgeText({
        title: uniqueTitle("Owner Team Page"),
        text: "content",
        tenantId: TENANT,
        userId: MEMBER,
        teamId,
      });
      // direct check: owner passes without any role lookup
      await checkKnowledgeTextWritePermission(page, {
        tenantId: TENANT,
        userId: MEMBER,
      });
    });
  });

  describe("moving pages between containers", () => {
    it("a non-team-member cannot move their page into the team", async () => {
      const page = await createKnowledgeText({
        title: uniqueTitle("Move Attempt"),
        text: "content",
        tenantId: TENANT,
        userId: OUTSIDER,
      });

      await expect(
        updateKnowledgeText(
          page.id,
          { teamId },
          { tenantId: TENANT, userId: OUTSIDER }
        )
      ).rejects.toThrow();
    });

    it("a team member can move their page into the team", async () => {
      const page = await createKnowledgeText({
        title: uniqueTitle("Move Allowed"),
        text: "content",
        tenantId: TENANT,
        userId: MEMBER,
      });

      const moved = await updateKnowledgeText(
        page.id,
        { teamId },
        { tenantId: TENANT, userId: MEMBER }
      );
      expect(moved.teamId).toBe(teamId);
    });
  });

  describe("read/write access level per user", () => {
    it("team membership defaults to write access", async () => {
      expect(await getTeamMemberKnowledgeAccess(teamId, MEMBER)).toBe("write");
    });

    it("a read-only team member can read but not write team pages", async () => {
      // dedicated team so toggling access cannot leak into other tests
      const roTeam = await createTeam({
        name: `RO Team ${crypto.randomUUID()}`,
        tenantId: TENANT,
      });
      // MEMBER writes, OUTSIDER is read-only
      await addTeamMember(roTeam.id, TENANT, MEMBER, "member", "write");
      await addTeamMember(roTeam.id, TENANT, OUTSIDER, "member", "read");

      const page = await createKnowledgeText({
        title: uniqueTitle("RO Team Page"),
        text: "team content",
        tenantId: TENANT,
        userId: MEMBER,
        teamId: roTeam.id,
      });

      // read-only member CAN read the page
      const seen = await getKnowledgeTextById(page.id, {
        tenantId: TENANT,
        userId: OUTSIDER,
      });
      expect(seen.id).toBe(page.id);

      // ...but cannot update, block-save or delete it
      await expect(
        updateKnowledgeText(
          page.id,
          { text: "nope" },
          { tenantId: TENANT, userId: OUTSIDER }
        )
      ).rejects.toThrow();
      await expect(
        syncKnowledgeTextBlocks(
          page.id,
          [{ type: "markdown", content: "nope" }],
          { tenantId: TENANT, userId: OUTSIDER }
        )
      ).rejects.toThrow();
      await expect(
        deleteKnowledgeText(page.id, { tenantId: TENANT, userId: OUTSIDER })
      ).rejects.toThrow();

      // ...and cannot create a new page inside the team
      await expect(
        createKnowledgeText({
          title: uniqueTitle("RO Create Attempt"),
          text: "nope",
          tenantId: TENANT,
          userId: OUTSIDER,
          teamId: roTeam.id,
        })
      ).rejects.toThrow();
    });

    it("granting write access lets a former read-only member write again", async () => {
      const roTeam = await createTeam({
        name: `RO Grant Team ${crypto.randomUUID()}`,
        tenantId: TENANT,
      });
      await addTeamMember(roTeam.id, TENANT, MEMBER, "member", "write");
      await addTeamMember(roTeam.id, TENANT, OUTSIDER, "member", "read");

      const page = await createKnowledgeText({
        title: uniqueTitle("RO Grant Page"),
        text: "team content",
        tenantId: TENANT,
        userId: MEMBER,
        teamId: roTeam.id,
      });

      await expect(
        updateKnowledgeText(
          page.id,
          { text: "still read-only" },
          { tenantId: TENANT, userId: OUTSIDER }
        )
      ).rejects.toThrow();

      // upgrade to write
      await updateTeamMemberKnowledgeAccess(roTeam.id, OUTSIDER, "write");

      const updated = await updateKnowledgeText(
        page.id,
        { text: "now writable" },
        { tenantId: TENANT, userId: OUTSIDER }
      );
      expect(updated.text).toBe("now writable");
    });

    it("a read-only tenant member can read but not write tenant-wide pages", async () => {
      const before = await getTenantMemberKnowledgeAccess(TENANT, OUTSIDER);
      expect(before).toBe("write"); // default

      const page = await createKnowledgeText({
        title: uniqueTitle("RO Org Page"),
        text: "org wide content",
        tenantId: TENANT,
        userId: OWNER,
        tenantWide: true,
      });

      // downgrade OUTSIDER to read-only in the tenant
      await updateTenantMemberKnowledgeAccess(TENANT, OUTSIDER, "read");
      try {
        // can still read
        const seen = await getKnowledgeTextById(page.id, {
          tenantId: TENANT,
          userId: OUTSIDER,
        });
        expect(seen.id).toBe(page.id);

        // cannot update an existing tenant-wide page
        await expect(
          updateKnowledgeText(
            page.id,
            { text: "nope" },
            { tenantId: TENANT, userId: OUTSIDER }
          )
        ).rejects.toThrow();

        // cannot create a new tenant-wide page
        await expect(
          createKnowledgeText({
            title: uniqueTitle("RO Org Create Attempt"),
            text: "nope",
            tenantId: TENANT,
            userId: OUTSIDER,
            tenantWide: true,
          })
        ).rejects.toThrow();
      } finally {
        // restore default so later runs / tests are unaffected
        await updateTenantMemberKnowledgeAccess(TENANT, OUTSIDER, "write");
      }

      // restored member can write again
      const updated = await updateKnowledgeText(
        page.id,
        { text: "writable again" },
        { tenantId: TENANT, userId: OUTSIDER }
      );
      expect(updated.text).toBe("writable again");
    });

    it("a read-only member still writes their own personal pages", async () => {
      const roTeam = await createTeam({
        name: `RO Own Team ${crypto.randomUUID()}`,
        tenantId: TENANT,
      });
      await addTeamMember(roTeam.id, TENANT, OUTSIDER, "member", "read");

      // a private page (no team, not tenant-wide) is unaffected by the
      // team/tenant access level
      const page = await createKnowledgeText({
        title: uniqueTitle("RO Own Private"),
        text: "my notes",
        tenantId: TENANT,
        userId: OUTSIDER,
      });
      const updated = await updateKnowledgeText(
        page.id,
        { text: "my updated notes" },
        { tenantId: TENANT, userId: OUTSIDER }
      );
      expect(updated.text).toBe("my updated notes");
    });
  });
});
