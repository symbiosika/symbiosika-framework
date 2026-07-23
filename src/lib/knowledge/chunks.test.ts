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
import { knowledgeEntry, knowledgeChunks } from "../db/schema/knowledge";
import { teamMembers, teams } from "../db/schema/users";
import { eq } from "drizzle-orm";

beforeAll(async () => {
  await initTests();
});

describe("Knowledge Chunks CRUD Operations", () => {
  let testKnowledgeEntryId: string;
  let testKnowledgeChunkId: string;
  let testTeamId: string;

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

      // Cleanup: remove membership and detach the team again so later tests
      // see the entry without team access.
      await getDb()
        .delete(teamMembers)
        .where(eq(teamMembers.userId, TEST_ORG1_USER_1.id));
      await getDb()
        .update(knowledgeEntry)
        .set({ teamId: null })
        .where(eq(knowledgeEntry.id, testKnowledgeEntryId));
    });

    test("should not be able to access a knowledge chunk when lacking required permissions", async () => {
      // Entry restricted to a team the requesting user is NOT a member of.
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

      const restrictedEntry = await getDb()
        .insert(knowledgeEntry)
        .values({
          tenantId: TEST_ORGANISATION_1.id,
          name: "Restricted Entry",
          description: "Entry with restricted access",
          userId: TEST_ADMIN_USER.id,
          teamId: restrictedTeam[0].id,
        })
        .returning();

      if (!restrictedEntry[0]) {
        throw new Error("Failed to create restricted entry");
      }

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

      // TEST_ORG1_USER_1 is not the owner and not a member of the restricted
      // team → access must be denied.
      await expect(
        getKnowledgeChunkById(
          restrictedChunk[0].id,
          TEST_ORGANISATION_1.id,
          TEST_ORG1_USER_1.id
        )
      ).rejects.toThrow("Knowledge chunk not found");

      // Cleanup
      await getDb()
        .delete(knowledgeChunks)
        .where(eq(knowledgeChunks.id, restrictedChunk[0].id));
      await getDb()
        .delete(knowledgeEntry)
        .where(eq(knowledgeEntry.id, restrictedEntry[0].id));
      await getDb().delete(teams).where(eq(teams.id, restrictedTeam[0].id));
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

      // Cleanup
      await getDb()
        .delete(knowledgeChunks)
        .where(eq(knowledgeChunks.id, otherOrgChunk[0].id));
      await getDb()
        .delete(knowledgeEntry)
        .where(eq(knowledgeEntry.id, otherOrgEntry[0].id));
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
    await getDb().delete(teams).where(eq(teams.id, testTeamId));
  });
});
