import { describe, test, expect, beforeAll } from "bun:test";
import { testFetcher } from "../../../../../test/fetcher.test";
import defineRoutes from ".";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../../../../../test/init.test";
import { Hono } from "hono";
import type { FastAppHonoContextVariables } from "../../../../../types";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../../../../../lib/db/db-connection";
import { getDb } from "../../../../../lib/db/db-connection";
import {
  knowledgeEntry,
  knowledgeChunks,
} from "../../../../../lib/db/db-schema";

let app = new Hono<{ Variables: FastAppHonoContextVariables }>();
let TEST_USER_1_TOKEN: string;
let testKnowledgeEntryId: string;
let testKnowledgeChunkId: string;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(app, "/api");
  const { user1Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;

  // Create a test knowledge entry
  const entryId = "00000000-1111-1111-1111-000000000004";
  await getDb().insert(knowledgeEntry).values({
    id: entryId,
    tenantId: TEST_ORGANISATION_1.id,
    name: "Test Knowledge Entry",
    userId: TEST_ORG1_USER_1.id,
  });
  testKnowledgeEntryId = entryId;

  // Create a test knowledge chunk
  const chunkId = "00000000-1111-1111-1111-000000000005";
  // Create a 1536-dimensional vector filled with small random values
  const mockEmbedding = Array(1536)
    .fill(0)
    .map(() => Math.random() * 0.1);
  await getDb().insert(knowledgeChunks).values({
    id: chunkId,
    knowledgeEntryId: entryId,
    text: "Test chunk text",
    header: "Test header",
    order: 0,
    textEmbedding: mockEmbedding,
    embeddingModel: "test-model",
  });
  testKnowledgeChunkId = chunkId;
});

describe("Knowledge Chunks API Endpoints", () => {
  test("Get a knowledge chunk by ID", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/chunks/${testKnowledgeChunkId}`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.id).toBe(testKnowledgeChunkId);
    expect(response.jsonResponse.text).toBe("Test chunk text");
  });

  test("Should return 400 for non-existent chunk", async () => {
    const nonExistentId = "00000000-1111-1111-1111-000000000006";
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/chunks/${nonExistentId}`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(400);
    expect(response.textResponse).toBe("Error: Knowledge chunk not found");
  });

  test("Should return 401 for unauthorized access", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/chunks/${testKnowledgeChunkId}`,
      "invalid-token"
    );

    expect(response.status).toBe(401);
  });
});
