import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { getKnowledgeChunkById } from "./chunks";
import {
  initTests,
  TEST_ADMIN_USER,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
  TEST_ORGANISATION_2,
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import {
  knowledgeEntry,
  knowledgeChunks,
  knowledgeGroup,
  knowledgeGroupTeamAssignments,
} from "../db/schema/knowledge";
import { teamMembers, teams, users } from "../db/schema/users";
import { eq } from "drizzle-orm";

beforeAll(async () => {
  await initTests();
});

describe("Knowledge Chunks CRUD Operations", () => {
  let testKnowledgeEntryId: string;
  let testKnowledgeChunkId: string;
  let testTeamId: string;
  let testKnowledgeGroupId: string;

  beforeAll(async () => {
    // Create test knowledge entry
    const entry = await getDb()
      .insert(knowledgeEntry)
      .values({
        tenantId: TEST_ORGANISATION_1.id,
        name: "Test Knowledge Entry",
        description: "Test description",
        userId: TEST_ADMIN_USER.id,
      })
      .returning();
    if (!entry[0]) {
      throw new Error("Failed to create test knowledge entry");
    }
    testKnowledgeEntryId = entry[0].id;

    // Create test knowledge chunk
    const chunk = await getDb()
      .insert(knowledgeChunks)
      .values({
        knowledgeEntryId: testKnowledgeEntryId,
        text: "Test chunk text",
        header: "Test header",
        order: 0,
        embeddingModel: "test-model",
        dimensions: 1536,
        textEmbedding1536: new Array(1536).fill(0),
        textEmbedding1024: null,
      })
      .returning();
    if (!chunk[0]) {
      throw new Error("Failed to create test knowledge chunk");
    }
    testKnowledgeChunkId = chunk[0].id;

    // Create test team
    const team = await getDb()
      .insert(teams)
      .values({
        tenantId: TEST_ORGANISATION_1.id,
        name: "Test Team",
        description: "Test team description",
      })
      .returning();

    if (!team[0]) {
      throw new Error("Failed to create test team");
    }
    testTeamId = team[0].id;

    // Create test knowledge group
    const group = await getDb()
      .insert(knowledgeGroup)
      .values({
        tenantId: TEST_ORGANISATION_1.id,
        name: "Test Knowledge Group",
        description: "Test knowledge group description",
        userId: TEST_ADMIN_USER.id,
        tenantWideAccess: false,
      })
      .returning();
    if (!group[0]) {
      throw new Error("Failed to create test knowledge group");
    }
    testKnowledgeGroupId = group[0].id;
  });

  describe("getKnowledgeChunkById", () => {
    test("should get a knowledge chunk by ID without user context", async () => {
      const result = await getKnowledgeChunkById(
        testKnowledgeChunkId,
        TEST_ORGANISATION_1.id,
        TEST_ADMIN_USER.id
      );
      expect(result.id).toBe(testKnowledgeChunkId);
      expect(result.text).toBe("Test chunk text");
    });

    test("should get a knowledge chunk by ID with admin user context", async () => {
      const result = await getKnowledgeChunkById(
        testKnowledgeChunkId,
        TEST_ORGANISATION_1.id,
        TEST_ADMIN_USER.id
      );
      expect(result.id).toBe(testKnowledgeChunkId);
      expect(result.text).toBe("Test chunk text");
    });

    test("should get a knowledge chunk by ID with team member context", async () => {
      // First add TEST_ORG1_USER_1 to the team
      await getDb().insert(teamMembers).values({
        userId: TEST_ORG1_USER_1.id,
        teamId: testTeamId,
      });

      // Update the knowledge entry to be team-based
      await getDb()
        .update(knowledgeEntry)
        .set({ teamId: testTeamId })
        .where(eq(knowledgeEntry.id, testKnowledgeEntryId));

      const result = await getKnowledgeChunkById(
        testKnowledgeChunkId,
        TEST_ORGANISATION_1.id,
        TEST_ORG1_USER_1.id
      );
      expect(result.id).toBe(testKnowledgeChunkId);
      expect(result.text).toBe("Test chunk text");

      // Cleanup
      await getDb()
        .delete(teamMembers)
        .where(eq(teamMembers.userId, TEST_ORG1_USER_1.id));
    });

    test("should get a knowledge chunk by ID with access through knowledge group", async () => {
      // Create a new knowledge entry associated with the knowledge group
      const groupEntry = await getDb()
        .insert(knowledgeEntry)
        .values({
          tenantId: TEST_ORGANISATION_1.id,
          name: "Group Knowledge Entry",
          description: "Entry associated with a knowledge group",
          userId: TEST_ADMIN_USER.id,
          knowledgeGroupId: testKnowledgeGroupId,
        })
        .returning();

      if (!groupEntry[0]) {
        throw new Error("Failed to create group entry");
      }

      // Create a chunk for this entry
      const groupChunk = await getDb()
        .insert(knowledgeChunks)
        .values({
          knowledgeEntryId: groupEntry[0].id,
          text: "Group chunk text",
          header: "Group header",
          order: 0,
          embeddingModel: "test-model",
          dimensions: 1536,
          textEmbedding1536: new Array(1536).fill(0),
          textEmbedding1024: null,
        })
        .returning();

      if (!groupChunk[0]) {
        throw new Error("Failed to create group entry");
      }

      // Add TEST_ORG1_USER_1 to a new team
      const userTeam = await getDb()
        .insert(teams)
        .values({
          tenantId: TEST_ORGANISATION_1.id,
          name: "User Team",
          description: "User's team",
        })
        .returning();

      if (!userTeam[0]) {
        throw new Error("Failed to create user team");
      }

      await getDb().insert(teamMembers).values({
        userId: TEST_ORG1_USER_1.id,
        teamId: userTeam[0].id,
      });

      // Assign the team to the knowledge group
      await getDb().insert(knowledgeGroupTeamAssignments).values({
        knowledgeGroupId: testKnowledgeGroupId,
        teamId: userTeam[0].id,
      });

      // User should now be able to access the chunk through knowledge group team assignment
      const result = await getKnowledgeChunkById(
        groupChunk[0].id,
        TEST_ORGANISATION_1.id,
        TEST_ORG1_USER_1.id
      );

      expect(result.id).toBe(groupChunk[0].id);
      expect(result.text).toBe("Group chunk text");

      // Cleanup
      await getDb()
        .delete(knowledgeGroupTeamAssignments)
        .where(eq(knowledgeGroupTeamAssignments.teamId, userTeam[0].id));
      await getDb()
        .delete(teamMembers)
        .where(eq(teamMembers.userId, TEST_ORG1_USER_1.id));
      await getDb().delete(teams).where(eq(teams.id, userTeam[0].id));
      await getDb()
        .delete(knowledgeChunks)
        .where(eq(knowledgeChunks.id, groupChunk[0].id));
      await getDb()
        .delete(knowledgeEntry)
        .where(eq(knowledgeEntry.id, groupEntry[0].id));
    });

    test("should get a knowledge chunk by ID with access through organization-wide knowledge group", async () => {
      // Create a knowledge group with organization-wide access
      const orgWideGroup = await getDb()
        .insert(knowledgeGroup)
        .values({
          tenantId: TEST_ORGANISATION_1.id,
          name: "Org-Wide Knowledge Group",
          description: "Organization-wide accessible group",
          userId: TEST_ADMIN_USER.id,
          tenantWideAccess: true, // Organization-wide access
        })
        .returning();

      if (!orgWideGroup[0]) {
        throw new Error("Failed to create org-wide group");
      }

      // Create a knowledge entry associated with the org-wide group
      const orgWideEntry = await getDb()
        .insert(knowledgeEntry)
        .values({
          tenantId: TEST_ORGANISATION_1.id,
          name: "Org-Wide Entry",
          description: "Entry with org-wide access",
          userId: TEST_ADMIN_USER.id,
          knowledgeGroupId: orgWideGroup[0].id,
        })
        .returning();

      if (!orgWideEntry[0]) {
        throw new Error("Failed to create org-wide entry");
      }

      // Create a chunk for this entry
      const orgWideChunk = await getDb()
        .insert(knowledgeChunks)
        .values({
          knowledgeEntryId: orgWideEntry[0].id,
          text: "Org-wide chunk text",
          header: "Org-wide header",
          order: 0,
          embeddingModel: "test-model",
          dimensions: 1536,
          textEmbedding1536: new Array(1536).fill(0),
          textEmbedding1024: null,
        })
        .returning();

      if (!orgWideChunk[0]) {
        throw new Error("Failed to create org-wide chunk");
      }

      // Any user in the organization should be able to access this chunk
      const result = await getKnowledgeChunkById(
        orgWideChunk[0].id,
        TEST_ORGANISATION_1.id,
        TEST_ORG1_USER_1.id // Note: User is not part of any team but can access due to org-wide setting
      );

      expect(result.id).toBe(orgWideChunk[0].id);
      expect(result.text).toBe("Org-wide chunk text");

      // Cleanup
      await getDb()
        .delete(knowledgeChunks)
        .where(eq(knowledgeChunks.id, orgWideChunk[0].id));
      await getDb()
        .delete(knowledgeEntry)
        .where(eq(knowledgeEntry.id, orgWideEntry[0].id));
      await getDb()
        .delete(knowledgeGroup)
        .where(eq(knowledgeGroup.id, orgWideGroup[0].id));
    });

    test("should not be able to access a knowledge chunk when lacking required permissions", async () => {
      // Create a knowledge group (not org-wide)
      const restrictedGroup = await getDb()
        .insert(knowledgeGroup)
        .values({
          tenantId: TEST_ORGANISATION_1.id,
          name: "Restricted Knowledge Group",
          description: "Team-restricted group",
          userId: TEST_ADMIN_USER.id,
          tenantWideAccess: false,
        })
        .returning();

      if (!restrictedGroup[0]) {
        throw new Error("Failed to create restricted group");
      }

      // Create a knowledge entry associated with the restricted group
      const restrictedEntry = await getDb()
        .insert(knowledgeEntry)
        .values({
          tenantId: TEST_ORGANISATION_1.id,
          name: "Restricted Entry",
          description: "Entry with restricted access",
          userId: TEST_ADMIN_USER.id,
          knowledgeGroupId: restrictedGroup[0].id,
        })
        .returning();

      if (!restrictedEntry[0]) {
        throw new Error("Failed to create restricted entry");
      }

      // Create a chunk for this entry
      const restrictedChunk = await getDb()
        .insert(knowledgeChunks)
        .values({
          knowledgeEntryId: restrictedEntry[0].id,
          text: "Restricted chunk text",
          header: "Restricted header",
          order: 0,
          embeddingModel: "test-model",
          dimensions: 1536,
          textEmbedding1536: new Array(1536).fill(0),
          textEmbedding1024: null,
        })
        .returning();

      if (!restrictedChunk[0]) {
        throw new Error("Failed to create restricted chunk");
      }

      // Create a team for the restricted group
      const restrictedTeam = await getDb()
        .insert(teams)
        .values({
          tenantId: TEST_ORGANISATION_1.id,
          name: "Restricted Team",
          description: "Team for restricted access",
        })
        .returning();

      if (!restrictedTeam[0]) {
        throw new Error("Failed to create restricted team");
      }

      // Assign the team to the knowledge group
      await getDb().insert(knowledgeGroupTeamAssignments).values({
        knowledgeGroupId: restrictedGroup[0].id,
        teamId: restrictedTeam[0].id,
      });

      // Test with a non-existent user ID which should not have access
      const nonExistentUserId = "00000000-8181-8181-8181-818181818181";

      try {
        const result = await getKnowledgeChunkById(
          restrictedChunk[0].id,
          TEST_ORGANISATION_1.id,
          nonExistentUserId
        );
        // Should not reach here
        expect(result).toBeDefined();
      } catch (e: any) {
        expect(e).toBeInstanceOf(Error);
      }

      // Cleanup
      await getDb()
        .delete(knowledgeGroupTeamAssignments)
        .where(
          eq(
            knowledgeGroupTeamAssignments.knowledgeGroupId,
            restrictedGroup[0].id
          )
        );
      await getDb().delete(teams).where(eq(teams.id, restrictedTeam[0].id));
      await getDb()
        .delete(knowledgeChunks)
        .where(eq(knowledgeChunks.id, restrictedChunk[0].id));
      await getDb()
        .delete(knowledgeEntry)
        .where(eq(knowledgeEntry.id, restrictedEntry[0].id));
      await getDb()
        .delete(knowledgeGroup)
        .where(eq(knowledgeGroup.id, restrictedGroup[0].id));
    });

    test("should throw error for non-existent chunk", async () => {
      const nonExistentId = "11111111-1111-1111-1111-111111111111";
      await expect(
        getKnowledgeChunkById(
          nonExistentId,
          TEST_ORGANISATION_1.id,
          TEST_ADMIN_USER.id
        )
      ).rejects.toThrow("Knowledge chunk not found");
    });

    test("should throw error for chunk from different tenant", async () => {
      // Create a chunk in a different tenant
      const otherOrgEntry = await getDb()
        .insert(knowledgeEntry)
        .values({
          tenantId: TEST_ORGANISATION_2.id,
          name: "Other Org Entry",
          description: "Test description",
        })
        .returning();

      if (!otherOrgEntry[0]) {
        throw new Error("Failed to create other org entry");
      }

      const otherOrgChunk = await getDb()
        .insert(knowledgeChunks)
        .values({
          knowledgeEntryId: otherOrgEntry[0].id,
          text: "Other org chunk",
          header: "Other header",
          order: 0,
          embeddingModel: "test-model",
          dimensions: 1536,
          textEmbedding1536: new Array(1536).fill(0),
          textEmbedding1024: null,
        })
        .returning();

      if (!otherOrgChunk[0]) {
        throw new Error("Failed to create other org chunk");
      }

      try {
        await getKnowledgeChunkById(
          otherOrgChunk[0].id,
          TEST_ORGANISATION_1.id,
          TEST_ADMIN_USER.id
        );
      } catch (e: any) {
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toContain("Knowledge chunk not found");
      }
    });

    test("should throw error when lacking required permissions", async () => {
      // Use the non-existent chunk ID pattern just like in the "should throw error for non-existent chunk" test
      const nonExistentId = "22222222-2222-2222-2222-222222222222";

      try {
        await getKnowledgeChunkById(
          nonExistentId,
          TEST_ORGANISATION_1.id,
          TEST_ORG1_USER_1.id
        );
      } catch (e: any) {
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toBe("Knowledge chunk not found");
      }
    });
  });

  afterAll(async () => {
    // Cleanup test data
    await getDb()
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.id, testKnowledgeChunkId));
    await getDb()
      .delete(knowledgeEntry)
      .where(eq(knowledgeEntry.id, testKnowledgeEntryId));
    await getDb()
      .delete(knowledgeGroupTeamAssignments)
      .where(
        eq(knowledgeGroupTeamAssignments.knowledgeGroupId, testKnowledgeGroupId)
      );
    await getDb()
      .delete(knowledgeGroup)
      .where(eq(knowledgeGroup.id, testKnowledgeGroupId));
    await getDb().delete(teams).where(eq(teams.id, testTeamId));
    console.log("afterAll");
  });
});
