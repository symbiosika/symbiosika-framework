import { describe, it, expect, beforeAll } from "bun:test";
import {
  createKnowledgeGroup,
  getKnowledgeGroups,
  getKnowledgeGroupById,
  updateKnowledgeGroup,
  deleteKnowledgeGroup,
  assignTeamToKnowledgeGroup,
  removeTeamFromKnowledgeGroup,
  getTeamsForKnowledgeGroup,
} from "./knowledge-groups";
import {
  type KnowledgeGroupSelect,
  type KnowledgeGroupTeamAssignmentSelect,
} from "../db/schema/knowledge";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../../test/init.test";
import { testing_createTeamAndAddUsers } from "../../test/permissions.test";

let testTokens: {
  user1Token: string;
  user2Token: string;
  user3Token: string;
  adminToken: string;
};

let TEST_TEAM_ID: string;

type KnowledgeGroupWithTeams = KnowledgeGroupSelect & {
  teamAssignments?: KnowledgeGroupTeamAssignmentSelect[];
};

describe("Knowledge Groups", () => {
  beforeAll(async () => {
    const tokens = await initTests();
    testTokens = tokens;

    const { teamId } = await testing_createTeamAndAddUsers(
      TEST_ORGANISATION_1.id,
      [TEST_ORG1_USER_1.id]
    );
    TEST_TEAM_ID = teamId;
  });

  describe("createKnowledgeGroup", () => {
    it("should create a new knowledge group", async () => {
      const groupData = {
        name: "Test Group Create",
        description: "Test Description",
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
        tenantWideAccess: false,
      };

      const newGroup = await createKnowledgeGroup(groupData);

      expect(newGroup.name).toBe("Test Group Create");
      expect(newGroup.description).toBe("Test Description");
      expect(newGroup.tenantId).toBe(TEST_ORGANISATION_1.id);
      expect(newGroup.userId).toBe(TEST_ORG1_USER_1.id);
      expect(newGroup.tenantWideAccess).toBe(false);
    });
  });

  describe("getKnowledgeGroups", () => {
    it("should return all knowledge groups for an tenant", async () => {
      // Create a test group
      await createKnowledgeGroup({
        name: "Test Group List",
        description: "Test Description",
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
        tenantWideAccess: false,
      });

      const groups = await getKnowledgeGroups({
        tenantId: TEST_ORGANISATION_1.id,
      });

      expect(groups.length).toBeGreaterThan(0);
      expect(groups.some((g) => g.name === "Test Group List")).toBe(true);
    });

    it("should filter groups by user", async () => {
      const groups = await getKnowledgeGroups({
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      expect(
        groups.every(
          (group) =>
            group.userId === TEST_ORG1_USER_1.id || group.tenantWideAccess
        )
      ).toBe(true);
    });

    it("should include team assignments when requested", async () => {
      // Create a test group
      const newGroup = await createKnowledgeGroup({
        name: "Test Group Team Assignments",
        description: "Test Description",
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
        tenantWideAccess: false,
      });

      // Assign a team
      await assignTeamToKnowledgeGroup(newGroup.id, TEST_TEAM_ID, {
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      const groups = (await getKnowledgeGroups({
        tenantId: TEST_ORGANISATION_1.id,
        includeTeamAssignments: true,
      })) as KnowledgeGroupWithTeams[];

      const group = groups.find((g) => g.id === newGroup.id);
      expect(group).toBeDefined();
      expect(group).toHaveProperty("teamAssignments");
      expect(group?.teamAssignments?.length).toBeGreaterThan(0);
    });
  });

  describe("getKnowledgeGroupById", () => {
    it("should return a specific knowledge group", async () => {
      // Create a test group
      const newGroup = await createKnowledgeGroup({
        name: "Test Group Get By ID",
        description: "Test Description",
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
        tenantWideAccess: false,
      });

      const group = await getKnowledgeGroupById(newGroup.id, {
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      expect(group).not.toBeNull();
      expect(group?.id).toBe(newGroup.id);
    });

    it("should return null for non-existent group", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      const group = await getKnowledgeGroupById(nonExistentId, {
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      expect(group).toBeNull();
    });
  });

  describe("updateKnowledgeGroup", () => {
    it("should update a knowledge group", async () => {
      // Create a test group
      const newGroup = await createKnowledgeGroup({
        name: "Test Group Update",
        description: "Test Description",
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
        tenantWideAccess: false,
      });

      const updatedGroup = await updateKnowledgeGroup(
        newGroup.id,
        {
          name: "Updated Group",
          description: "Updated Description",
        },
        {
          tenantId: TEST_ORGANISATION_1.id,
          userId: TEST_ORG1_USER_1.id,
        }
      );

      expect(updatedGroup.name).toBe("Updated Group");
      expect(updatedGroup.description).toBe("Updated Description");
    });

    it("should throw error when updating non-existent group", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      await expect(
        updateKnowledgeGroup(
          nonExistentId,
          { name: "Updated Group" },
          {
            tenantId: TEST_ORGANISATION_1.id,
            userId: TEST_ORG1_USER_1.id,
          }
        )
      ).rejects.toThrow();
    });
  });

  describe("deleteKnowledgeGroup", () => {
    it("should delete a knowledge group", async () => {
      // Create a test group
      const newGroup = await createKnowledgeGroup({
        name: "Test Group Delete",
        description: "Test Description",
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
        tenantWideAccess: false,
      });

      await deleteKnowledgeGroup(newGroup.id, {
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      const deletedGroup = await getKnowledgeGroupById(newGroup.id, {
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      expect(deletedGroup).toBeNull();
    });

    it("should throw error when deleting non-existent group", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      await expect(
        deleteKnowledgeGroup(nonExistentId, {
          tenantId: TEST_ORGANISATION_1.id,
          userId: TEST_ORG1_USER_1.id,
        })
      ).rejects.toThrow();
    });
  });

  describe("team assignments", () => {
    it("should assign a team to a knowledge group", async () => {
      // Create a test group
      const newGroup = await createKnowledgeGroup({
        name: "Test Group Team Assignment",
        description: "Test Description",
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
        tenantWideAccess: false,
      });

      await assignTeamToKnowledgeGroup(newGroup.id, TEST_TEAM_ID, {
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      const teams = await getTeamsForKnowledgeGroup(newGroup.id, {
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      expect(teams.length).toBeGreaterThan(0);
      expect(teams.some((t) => t.teamId === TEST_TEAM_ID)).toBe(true);
    }, 10000);

    it("should remove a team from a knowledge group", async () => {
      // Create a test group
      const newGroup = await createKnowledgeGroup({
        name: "Test Group Team Removal",
        description: "Test Description",
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
        tenantWideAccess: false,
      });

      // First assign the team
      await assignTeamToKnowledgeGroup(newGroup.id, TEST_TEAM_ID, {
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      // Then remove it
      await removeTeamFromKnowledgeGroup(newGroup.id, TEST_TEAM_ID, {
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      const teams = await getTeamsForKnowledgeGroup(newGroup.id, {
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
      });

      expect(teams).not.toContain(TEST_TEAM_ID);
    });
  });
});
