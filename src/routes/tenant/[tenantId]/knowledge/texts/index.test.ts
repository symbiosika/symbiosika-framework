import { describe, test, expect, beforeAll } from "bun:test";
import { testFetcher } from "../../../../../test/fetcher.test";
import defineRoutes from ".";
import { initTests, TEST_ORGANISATION_1 } from "../../../../../test/init.test";
import { Hono } from "hono";
import type { FastAppHonoContextVariables } from "../../../../../types";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../../../../../lib/db/db-connection";

let app = new Hono<{ Variables: FastAppHonoContextVariables }>();
let TEST_USER_1_TOKEN: string;
let createdKnowledgeTextId: string;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(app, "/api");
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
      app,
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

  test("Get knowledge text entries", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.jsonResponse)).toBe(true);
    expect(response.jsonResponse.length).toBeGreaterThan(0);
    expect(
      response.jsonResponse.some(
        (entry: any) => entry.id === createdKnowledgeTextId
      )
    ).toBe(true);
  });

  test("Update a knowledge text entry", async () => {
    const updatedData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "This is an updated test knowledge text.",
      title: "Updated Test Knowledge Text",
    };

    const response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createdKnowledgeTextId}`,
      TEST_USER_1_TOKEN,
      updatedData
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.text).toBe(updatedData.text);
    expect(response.jsonResponse.title).toBe(updatedData.title);
  });

  test("Delete a knowledge text entry", async () => {
    const response = await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createdKnowledgeTextId}`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
  });

  test("Create knowledge text with version, hidden and parentId", async () => {
    const parentData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Parent knowledge text for API test",
      title: "Parent API Test",
      version: 1,
      hidden: false,
    };

    const parentResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      parentData
    );

    expect(parentResponse.status).toBe(200);
    expect(parentResponse.jsonResponse.version).toBe(1);
    expect(parentResponse.jsonResponse.hidden).toBe(false);
    expect(parentResponse.jsonResponse.parentId).toBeNull();

    const childData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Child knowledge text for API test",
      title: "Child API Test",
      parentId: parentResponse.jsonResponse.id,
      version: 2,
      hidden: true,
    };

    const childResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      childData
    );

    expect(childResponse.status).toBe(200);
    expect(childResponse.jsonResponse.parentId).toBe(
      parentResponse.jsonResponse.id
    );
    expect(childResponse.jsonResponse.version).toBe(2);
    expect(childResponse.jsonResponse.hidden).toBe(true);

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${childResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${parentResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Update version and hidden attributes via API", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Text for version update test",
      title: "Version Update Test",
      version: 1,
      hidden: false,
    };

    const createResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(createResponse.status).toBe(200);

    const updateData = {
      tenantId: TEST_ORGANISATION_1.id,
      version: 3,
      hidden: true,
    };

    const updateResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      updateData
    );

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.jsonResponse.version).toBe(4); // 3+1 due to versioning
    expect(updateResponse.jsonResponse.hidden).toBe(true);

    // Cleanup - delete both versions
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${updateResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("PUT should create new version with incremented version number", async () => {
    const originalData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Original API text",
      title: "Original API Title",
      version: 1,
    };

    const createResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      originalData
    );

    expect(createResponse.status).toBe(200);
    const originalId = createResponse.jsonResponse.id;

    // Update via PUT
    const updateData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Updated API text",
      title: "Updated API Title",
    };

    const updateResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${originalId}`,
      TEST_USER_1_TOKEN,
      updateData
    );

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.jsonResponse.id).not.toBe(originalId); // New ID
    expect(updateResponse.jsonResponse.version).toBe(2); // Incremented
    expect(updateResponse.jsonResponse.text).toBe("Updated API text");
    expect(updateResponse.jsonResponse.title).toBe("Updated API Title");
    expect(updateResponse.jsonResponse.parentId).toBe(originalId);

    // Check original is hidden
    const getOriginalResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts?id=${originalId}`,
      TEST_USER_1_TOKEN
    );

    expect(getOriginalResponse.status).toBe(200);
    expect(getOriginalResponse.jsonResponse[0]?.hidden).toBe(true);

    // Cleanup both versions
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${updateResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${originalId}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Multiple PUTs should create version chain", async () => {
    const v1Response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 1",
        title: "Chain Test",
      }
    );

    const v1Id = v1Response.jsonResponse.id;

    // Create version 2
    const v2Response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v1Id}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 2",
      }
    );

    expect(v2Response.jsonResponse.version).toBe(2);
    expect(v2Response.jsonResponse.parentId).toBe(v1Id);

    // Create version 3
    const v3Response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v2Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 3",
      }
    );

    expect(v3Response.jsonResponse.version).toBe(3);
    expect(v3Response.jsonResponse.parentId).toBe(v1Id); // Points to root

    // Cleanup all versions
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v3Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v2Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v1Id}`,
      TEST_USER_1_TOKEN
    );
  });
});
