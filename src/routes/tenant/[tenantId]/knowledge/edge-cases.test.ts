import { describe, test, expect, beforeAll } from "bun:test";
import { testFetcher } from "../../../../test/fetcher.test";
import defineRoutes from "./index";
import defineRoutesKnowledgeTexts from "./texts";
import { initTests, TEST_ORGANISATION_1 } from "../../../../test/init.test";
import { Hono } from "hono";
import type { FastAppHonoContextVariables } from "../../../../types";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../../../../lib/db/db-connection";

let appKnowledge = new Hono<{ Variables: FastAppHonoContextVariables }>();
let appKnowledgeTexts = new Hono<{ Variables: FastAppHonoContextVariables }>();
let TEST_USER_1_TOKEN: string;
let createdKnowledgeTextId: string;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(appKnowledge, "/api");
  defineRoutesKnowledgeTexts(appKnowledgeTexts, "/api");
  const { user1Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;

  // Create a test knowledge text for edge case tests
  const textData = {
    tenantId: TEST_ORGANISATION_1.id,
    text: "This is a test knowledge text for edge case testing.",
    title: "Edge Case Test Knowledge Text",
  };

  const response = await testFetcher.post(
    appKnowledgeTexts,
    `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
    TEST_USER_1_TOKEN,
    textData
  );

  createdKnowledgeTextId = response.jsonResponse.id;
});

describe("Knowledge API Edge Cases", () => {
  test("Create knowledge text with empty text", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "",
      title: "Empty Text",
    };

    const response = await testFetcher.post(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    // Empty text is allowed
    expect(response.status).toBe(200);
    expect(response.jsonResponse.text).toBe("");
  });

  test("Create knowledge text with very long text", async () => {
    // Create a very long text (1,000,000 characters)
    const longText = "a".repeat(1000000);

    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: longText,
      title: "Very Long Text",
    };

    const response = await testFetcher.post(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    // The API should handle long texts appropriately
    // This might succeed or fail depending on the API limits
    expect([200, 400]).toContain(response.status);
  });

  test("Create knowledge text with very long title", async () => {
    // Create a very long title (10,000 characters)
    const longTitle = "a".repeat(10000);

    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "This is a test knowledge text with a very long title.",
      title: longTitle,
    };

    const response = await testFetcher.post(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    // Very long title should be rejected
    expect(response.status).toBe(400);
  });

  test("Extract knowledge with non-existent source ID", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    const extractData = {
      tenantId: TEST_ORGANISATION_1.id,
      sourceType: "text",
      sourceId: nonExistentId,
    };

    const response = await testFetcher.post(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/extract-knowledge`,
      TEST_USER_1_TOKEN,
      extractData
    );

    // Should return an error for non-existent source
    expect(response.status).toBe(400);
  });

  test("Get non-existent knowledge entry", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    const response = await testFetcher.get(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/entries/${nonExistentId}`,
      TEST_USER_1_TOKEN
    );

    // Should return a 400 error
    expect(response.status).toBe(400);
  });

  test("Delete non-existent knowledge entry", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    const response = await testFetcher.delete(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/entries/${nonExistentId}`,
      TEST_USER_1_TOKEN
    );

    // Should return a 400 error or a success with no effect
    expect([200, 400]).toContain(response.status);
  });

  test("Get non-existent knowledge text", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    const response = await testFetcher.get(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${nonExistentId}`,
      TEST_USER_1_TOKEN
    );

    // Should return 404 for non-existent entry
    expect(response.status).toBe(404);
  });

  test("Update non-existent knowledge text", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    const updatedData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "This is an updated text for a non-existent knowledge text.",
      title: "Non-existent Knowledge Text",
    };

    const response = await testFetcher.put(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${nonExistentId}`,
      TEST_USER_1_TOKEN,
      updatedData
    );

    // Should return a 400 error
    expect(response.status).toBe(400);
  });

  test("Delete non-existent knowledge text", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    const response = await testFetcher.delete(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${nonExistentId}`,
      TEST_USER_1_TOKEN
    );

    // Should return a 400 error or a success with no effect
    expect([200, 400]).toContain(response.status);
  });

  test("Similarity search with empty search text", async () => {
    const searchData = {
      tenantId: TEST_ORGANISATION_1.id,
      searchText: "",
    };

    const response = await testFetcher.post(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/similarity-search`,
      TEST_USER_1_TOKEN,
      searchData
    );

    // Empty search text should be rejected by validation
    expect(response.status).toBe(400);
  });

  test("Similarity search with very long search text", async () => {
    // Create a very long search text (100,000 characters)
    const longSearchText = "a".repeat(100000);

    const searchData = {
      tenantId: TEST_ORGANISATION_1.id,
      searchText: longSearchText,
    };

    const response = await testFetcher.post(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/similarity-search`,
      TEST_USER_1_TOKEN,
      searchData
    );

    // The API should handle long search texts appropriately
    // This might succeed or fail depending on the API limits
    expect([200, 400]).toContain(response.status);
  }, 15000);

  test("Upload and learn with empty form data", async () => {
    const formData = new FormData();
    // No file attached

    const response = await testFetcher.postFormData(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/upload-and-extract`,
      TEST_USER_1_TOKEN,
      formData
    );

    // Empty form data should be rejected
    // console.log("A", response.textResponse);
    expect(response.status).toBe(400);
  });

  // Clean up after edge case tests
  test("Clean up created knowledge text", async () => {
    const response = await testFetcher.delete(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createdKnowledgeTextId}`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
  });
});

// Import path module for file path operations
import { join } from "path";
import { readFileSync } from "fs";
import { TEST_PDF_TEXT } from "../../../../test/files.test";
