import { describe, test, expect, beforeAll } from "bun:test";
import { testFetcher } from "../../../../../test/fetcher.test";
import defineRoutes from ".";
import { initTests, TEST_ORGANISATION_1 } from "../../../../../test/init.test";
import { Hono } from "hono";
import type { SymbiosikaFrameworkHonoAppContextVariables } from "../../../../../types";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../../../../../lib/db/db-connection";

let app = new Hono<{ Variables: SymbiosikaFrameworkHonoAppContextVariables }>();
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
    expect(response.jsonResponse.id).toBe(createdKnowledgeTextId); // Same ID (not a new version)
  });

  test("Delete a knowledge text entry", async () => {
    const response = await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createdKnowledgeTextId}`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
  });

  test("Create knowledge text with hidden and parentId", async () => {
    const parentData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Parent knowledge text for API test",
      title: "Parent API Test",
      hidden: false,
    };

    const parentResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      parentData
    );

    expect(parentResponse.status).toBe(200);
    expect(parentResponse.jsonResponse.hidden).toBe(false);
    expect(parentResponse.jsonResponse.parentId).toBeNull();

    const childData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Child knowledge text for API test",
      title: "Child API Test",
      parentId: parentResponse.jsonResponse.id, // Wiki hierarchy
      hidden: true,
    };

    const childResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      childData
    );

    expect(childResponse.status).toBe(200);
    expect(childResponse.jsonResponse.parentId).toBe(parentResponse.jsonResponse.id); // Now stores id directly!
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

  test("Update hidden attribute via API", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Text for hidden update test",
      title: "Hidden Update Test",
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
      hidden: true,
    };

    const updateResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      updateData
    );

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.jsonResponse.hidden).toBe(true);
    expect(updateResponse.jsonResponse.id).toBe(createResponse.jsonResponse.id); // Same entry

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${updateResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("PUT should update entry and create history", async () => {
    const originalData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Original API text",
      title: "Original API Title",
    };

    const createResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      originalData
    );

    expect(createResponse.status).toBe(200);
    const entryId = createResponse.jsonResponse.id;

    // Update via PUT
    const updateData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Updated API text",
      title: "Updated API Title",
    };

    const updateResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${entryId}`,
      TEST_USER_1_TOKEN,
      updateData
    );

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.jsonResponse.id).toBe(entryId); // Same ID (updated in place)
    expect(updateResponse.jsonResponse.text).toBe("Updated API text");
    expect(updateResponse.jsonResponse.title).toBe("Updated API Title");
    expect(updateResponse.jsonResponse.parentId).toBeNull(); // parentId is for wiki hierarchy

    // Check history was created
    const historyResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${entryId}/history`,
      TEST_USER_1_TOKEN
    );

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.jsonResponse.length).toBeGreaterThan(0);
    // History should contain the original version
    expect(historyResponse.jsonResponse[0].text).toBe("Original API text");

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${updateResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Multiple PUTs should create multiple history entries", async () => {
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

    const entryId = v1Response.jsonResponse.id;

    // Update 1
    const v2Response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${entryId}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 2",
      }
    );

    expect(v2Response.jsonResponse.id).toBe(entryId); // Same entry
    expect(v2Response.jsonResponse.parentId).toBeNull(); // parentId is for wiki hierarchy

    // Update 2
    const v3Response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${entryId}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 3",
      }
    );

    expect(v3Response.jsonResponse.id).toBe(entryId); // Still same entry
    expect(v3Response.jsonResponse.parentId).toBeNull(); // parentId is for wiki hierarchy

    // Check history
    const historyResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${entryId}/history`,
      TEST_USER_1_TOKEN
    );

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.jsonResponse.length).toBe(2); // 2 updates = 2 history entries

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v3Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("GET list should return all entries without text content", async () => {
    const v1Response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Long text content",
        title: "API List Test",
      }
    );

    await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v1Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Updated long text content",
      }
    );

    // Get list - should return entry without text content
    const listResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN
    );

    expect(listResponse.status).toBe(200);
    const apiListTestEntries = listResponse.jsonResponse.filter(
      (entry: any) => entry.title === "API List Test"
    );

    expect(apiListTestEntries.length).toBe(1);
    expect(apiListTestEntries[0].id).toBe(v1Response.jsonResponse.id);
    expect(apiListTestEntries[0].hidden).toBe(false);
    expect(apiListTestEntries[0].text).toBeUndefined(); // Text should not be in list

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v1Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("GET history endpoint should return all history entries", async () => {
    const v1Response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 1",
        title: "History Test",
      }
    );

    const entryId = v1Response.jsonResponse.id;

    await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${entryId}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 2",
      }
    );

    await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${entryId}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 3",
      }
    );

    // Get history
    const historyResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${entryId}/history`,
      TEST_USER_1_TOKEN
    );

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.jsonResponse.length).toBe(2); // 2 updates = 2 history entries

    // Check order (newest first)
    expect(historyResponse.jsonResponse[0].text).toBe("Version 2");
    expect(historyResponse.jsonResponse[1].text).toBe("Version 1");

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${entryId}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Parent-child hierarchy should persist when parent is updated", async () => {
    // Create parent entry
    const parentResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Parent text v1",
        title: "Parent Entry",
      }
    );

    expect(parentResponse.status).toBe(200);
    const parentId = parentResponse.jsonResponse.id;

    // Create child entry pointing to parent
    const childResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Child text",
        title: "Child Entry",
        parentId: parentId,
      }
    );

    expect(childResponse.status).toBe(200);
    const childId = childResponse.jsonResponse.id;
    // Child's parentId should be parent's id
    expect(childResponse.jsonResponse.parentId).toBe(parentId);

    // Update parent (same id, just updates content)
    const parentUpdateResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${parentId}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Parent text v2",
        title: "Updated Parent Entry",
      }
    );

    expect(parentUpdateResponse.status).toBe(200);
    expect(parentUpdateResponse.jsonResponse.id).toBe(parentId); // Same ID

    // Get child again - parentId should STILL point to parent's id
    const childCheckResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${childId}`,
      TEST_USER_1_TOKEN
    );

    expect(childCheckResponse.status).toBe(200);
    expect(childCheckResponse.jsonResponse.parentId).toBe(parentId); // Still valid!

    // Create another child using the parent's id
    const child2Response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Second child text",
        title: "Second Child Entry",
        parentId: parentId,
      }
    );

    expect(child2Response.status).toBe(200);
    expect(child2Response.jsonResponse.parentId).toBe(parentId); // Also points to same id

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${child2Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${childId}`,
      TEST_USER_1_TOKEN
    );
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${parentId}`,
      TEST_USER_1_TOKEN
    );
  });
});
