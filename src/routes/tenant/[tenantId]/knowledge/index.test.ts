import { describe, test, expect, beforeAll } from "bun:test";
import { testFetcher } from "../../../../test/fetcher.test";
import defineRoutes from ".";
import defineRoutesTexts from "./texts";
import {
  initTests,
  TEST_ORGANISATION_1,
} from "../../../../test/init.test";
import { Hono } from "hono";
import type { SFContextVariables } from "../../../../types";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../../../../lib/db/db-connection";

let appKnowledge = new Hono<{ Variables: SFContextVariables }>();
let appTexts = new Hono<{ Variables: SFContextVariables }>();

let TEST_USER_1_TOKEN: string;
let createdKnowledgeTextId: string;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(appKnowledge, "/api");
  defineRoutesTexts(appTexts, "/api");

  const { user1Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
});

describe("Knowledge API Endpoints", () => {
  test("Create a knowledge text entry", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "This is a test knowledge text for unit testing.",
      title: "Test Knowledge Text",
    };

    const response = await testFetcher.post(
      appTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.text).toBe(textData.text);
    expect(response.jsonResponse.title).toBe(textData.title);
    expect(response.jsonResponse.id).toBeDefined();

    // Save the ID for later tests
    createdKnowledgeTextId = response.jsonResponse.id;
  });

  test("Perform similarity search", async () => {
    const searchData = {
      tenantId: TEST_ORGANISATION_1.id,
      searchText: "test knowledge",
    };

    const response = await testFetcher.post(
      appKnowledge,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/similarity-search`,
      TEST_USER_1_TOKEN,
      searchData
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.jsonResponse)).toBe(true);
  });

  // Cleanup - run last
  test("Delete a knowledge text entry", async () => {
    const response = await testFetcher.delete(
      appTexts,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createdKnowledgeTextId}`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
  });
});
