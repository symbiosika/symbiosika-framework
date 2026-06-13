import { describe, test, expect, beforeAll } from "bun:test";
import { testFetcher } from "../../../../test/fetcher.test";
import defineRoutes from ".";
import defineRoutesKnowledgeTexts from "./texts";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORGANISATION_2,
} from "../../../../test/init.test";
import { Hono } from "hono";
import type { SFContextVariables } from "../../../../types";
import { rejectUnauthorized } from "../../../../test/reject-unauthorized.test";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../../../../lib/db/db-connection";

let appKnowledge = new Hono<{ Variables: SFContextVariables }>();
let appKnowledgeTexts = new Hono<{ Variables: SFContextVariables }>();

let TEST_USER_1_TOKEN: string;
let TEST_USER_2_TOKEN: string;
let createdKnowledgeTextId: string;
let createdKnowledgeEntryId: string;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(appKnowledge, "/api");
  defineRoutesKnowledgeTexts(appKnowledgeTexts, "/api");

  const { user1Token, user2Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
  TEST_USER_2_TOKEN = user2Token;

  // Create a test knowledge text for security tests
  const textData = {
    tenantId: TEST_ORGANISATION_1.id,
    text: "This is a test knowledge text for security testing.",
    title: "Security Test Knowledge Text",
  };

  const response = await testFetcher.post(
    appKnowledgeTexts,
    `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
    TEST_USER_1_TOKEN,
    textData
  );

  createdKnowledgeTextId = response.jsonResponse.id;

  // Create a knowledge entry from the text
  const parseData = {
    sourceType: "text",
    sourceId: createdKnowledgeTextId,
    tenantId: TEST_ORGANISATION_1.id,
  };

  const parseResponse = await testFetcher.post(
    appKnowledge,
    `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/extract-knowledge`,
    TEST_USER_1_TOKEN,
    parseData
  );

  createdKnowledgeEntryId = parseResponse.jsonResponse.id;
});

describe("Knowledge API Security Tests", () => {
  test("Endpoints should reject unauthorized requests", async () => {
    await rejectUnauthorized(appKnowledge, [
      ["GET", `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/entries`],
      [
        "GET",
        `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/entries/${createdKnowledgeEntryId}`,
      ],
      [
        "DELETE",
        `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/entries/${createdKnowledgeEntryId}`,
      ],
      [
        "POST",
        `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/extract-knowledge`,
      ],
      [
        "POST",
        `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/similarity-search`,
      ],
      [
        "POST",
        `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/from-text`,
      ],
      [
        "POST",
        `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/upload-and-extract`,
      ],
    ]);
  });

  test("Knowledge texts endpoints should reject unauthorized requests", async () => {
    await rejectUnauthorized(appKnowledgeTexts, [
      ["GET", `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`],
      ["POST", `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`],
      [
        "PUT",
        `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createdKnowledgeTextId}`,
      ],
      [
        "DELETE",
        `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createdKnowledgeTextId}`,
      ],
    ]);
  });

  test("User cannot access knowledge entries in another tenant", async () => {
    // User 2 tries to access tenant 1's knowledge entries
    const response = await testFetcher.get(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/entries`,
      TEST_USER_2_TOKEN
    );

    // Should be rejected due to tenant permission check
    expect(response.status).toBe(403);
  });

  test("User cannot access specific knowledge entry in another tenant", async () => {
    // User 2 tries to access a specific knowledge entry in tenant 1
    const response = await testFetcher.get(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/entries/${createdKnowledgeEntryId}`,
      TEST_USER_2_TOKEN
    );

    // Should be rejected due to tenant permission check
    expect(response.status).toBe(403);
  });

  test("User cannot delete knowledge entry in another tenant", async () => {
    // User 2 tries to delete a knowledge entry in tenant 1
    const response = await testFetcher.delete(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/entries/${createdKnowledgeEntryId}`,
      TEST_USER_2_TOKEN
    );

    // Should be rejected due to tenant permission check
    expect(response.status).toBe(403);
  });

  test("User cannot extract knowledge in another tenant", async () => {
    const extractData = {
      tenantId: TEST_ORGANISATION_1.id,
      sourceType: "text",
      sourceId: createdKnowledgeTextId,
    };

    // User 2 tries to extract knowledge in tenant 1
    const response = await testFetcher.post(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/extract-knowledge`,
      TEST_USER_2_TOKEN,
      extractData
    );

    // Should be rejected due to tenant permission check
    expect(response.status).toBe(403);
  });

  test("User cannot perform similarity search in another tenant", async () => {
    const searchData = {
      tenantId: TEST_ORGANISATION_1.id,
      searchText: "test knowledge",
    };

    // User 2 tries to perform similarity search in tenant 1
    const response = await testFetcher.post(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/similarity-search`,
      TEST_USER_2_TOKEN,
      searchData
    );

    // Should be rejected due to tenant permission check
    expect(response.status).toBe(403);
  });

  test("User cannot add knowledge from text in another tenant", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "This is a test knowledge text from an unauthorized user.",
      title: "Unauthorized Knowledge Text",
    };

    // User 2 tries to add knowledge from text in tenant 1
    const response = await testFetcher.post(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/from-text`,
      TEST_USER_2_TOKEN,
      textData
    );

    // Should be rejected due to tenant permission check
    expect(response.status).toBe(403);
  });

  test("User cannot access knowledge texts in another tenant", async () => {
    // User 2 tries to access tenant 1's knowledge texts
    const response = await testFetcher.get(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_2_TOKEN
    );

    // Should be rejected due to tenant permission check
    expect(response.status).toBe(403);
  });

  test("User cannot create knowledge text in another tenant", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "This is a test knowledge text from an unauthorized user.",
      title: "Unauthorized Knowledge Text",
    };

    // User 2 tries to create knowledge text in tenant 1
    const response = await testFetcher.post(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_2_TOKEN,
      textData
    );

    // Should be rejected due to tenant permission check
    expect(response.status).toBe(403);
  });

  test("User cannot update knowledge text in another tenant", async () => {
    const updatedData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "This knowledge text has been hacked.",
      title: "Hacked Knowledge Text",
    };

    // User 2 tries to update knowledge text in tenant 1
    const response = await testFetcher.put(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createdKnowledgeTextId}`,
      TEST_USER_2_TOKEN,
      updatedData
    );

    // Should be rejected due to tenant permission check
    expect(response.status).toBe(403);
  });

  test("User cannot delete knowledge text in another tenant", async () => {
    // User 2 tries to delete knowledge text in tenant 1
    const response = await testFetcher.delete(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createdKnowledgeTextId}`,
      TEST_USER_2_TOKEN
    );

    // Should be rejected due to tenant permission check
    expect(response.status).toBe(403);
  });

  test("Organisation ID mismatch in body and URL should be rejected", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_2.id, // Mismatch with URL
      text: "This is a test knowledge text with mismatched tenant IDs.",
      title: "Mismatch Knowledge Text",
    };

    // Try to create knowledge text with mismatched tenant IDs
    const response = await testFetcher.post(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    // Should be rejected due to tenant ID mismatch
    expect(response.status).toBe(400);
    expect(response.textResponse).toContain("does not match");
  });

  test("Invalid tenant ID should be rejected", async () => {
    const invalidOrgId = "invalid-org-id";

    // Try to access knowledge entries with invalid tenant ID
    const response = await testFetcher.get(
      appKnowledge,
      `/api/tenant/${invalidOrgId}/knowledge/entries`,
      TEST_USER_1_TOKEN
    );

    // Should be rejected
    expect(response.status).not.toBe(200);
  });

  test("User can access their own tenant's endpoints", async () => {
    // User 2 accesses their own tenant's knowledge entries
    const response = await testFetcher.get(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_2.id}/knowledge/entries`,
      TEST_USER_2_TOKEN
    );

    // Should be allowed
    expect(response.status).toBe(200);
  });

  // Clean up after security tests
  test("Clean up created knowledge entry", async () => {
    const response = await testFetcher.delete(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/entries/${createdKnowledgeEntryId}`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
  });

  test("Clean up created knowledge text", async () => {
    const response = await testFetcher.delete(
      appKnowledgeTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createdKnowledgeTextId}`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
  });
});
