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
    expect(parentResponse.jsonResponse.isLatest).toBe(true);
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
    expect(childResponse.jsonResponse.parentId).toBe(
      parentResponse.jsonResponse.documentId // Now stores documentId, not id!
    );
    expect(childResponse.jsonResponse.version).toBe(1); // New entry starts at version 1
    expect(childResponse.jsonResponse.isLatest).toBe(true);
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
      hidden: false,
    };

    const createResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(createResponse.status).toBe(200);
    expect(createResponse.jsonResponse.version).toBe(1);
    expect(createResponse.jsonResponse.isLatest).toBe(true);

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
    expect(updateResponse.jsonResponse.version).toBe(2); // Auto-incremented from 1
    expect(updateResponse.jsonResponse.isLatest).toBe(true);
    expect(updateResponse.jsonResponse.hidden).toBe(true);
    expect(updateResponse.jsonResponse.documentId).toBe(createResponse.jsonResponse.documentId);

    // Cleanup - cascade delete removes all versions
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${updateResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("PUT should create new version with incremented version number", async () => {
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
    const originalId = createResponse.jsonResponse.id;
    const documentId = createResponse.jsonResponse.documentId;

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
    expect(updateResponse.jsonResponse.id).not.toBe(originalId); // New ID for new version
    expect(updateResponse.jsonResponse.version).toBe(2); // Incremented from 1
    expect(updateResponse.jsonResponse.text).toBe("Updated API text");
    expect(updateResponse.jsonResponse.title).toBe("Updated API Title");
    expect(updateResponse.jsonResponse.documentId).toBe(documentId); // Same documentId
    expect(updateResponse.jsonResponse.parentId).toBeNull(); // parentId is for wiki hierarchy, not versioning
    expect(updateResponse.jsonResponse.isLatest).toBe(true);

    // Check original is no longer latest - use versionId parameter to get specific version
    const getOriginalResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${originalId}?versionId=${originalId}`,
      TEST_USER_1_TOKEN
    );

    expect(getOriginalResponse.status).toBe(200);
    expect(getOriginalResponse.jsonResponse.isLatest).toBe(false); // Not latest anymore

    // Cleanup - cascade delete removes all versions
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${updateResponse.jsonResponse.id}`,
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
    const documentId = v1Response.jsonResponse.documentId;

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
    expect(v2Response.jsonResponse.documentId).toBe(documentId);
    expect(v2Response.jsonResponse.parentId).toBeNull(); // parentId is for wiki hierarchy

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
    expect(v3Response.jsonResponse.documentId).toBe(documentId); // Same documentId for all versions
    expect(v3Response.jsonResponse.parentId).toBeNull(); // parentId is for wiki hierarchy

    // Cleanup - cascade delete removes all versions
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v3Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("GET list should return only latest versions (hidden=false) without text content", async () => {
    const v1Response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 1 with long text content",
        title: "API List Test",
      }
    );

    const v2Response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v1Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 2 with long text content",
      }
    );

    const v3Response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v2Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 3 with long text content",
      }
    );

    // Get list - should only return latest version without text content
    const listResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN
    );

    expect(listResponse.status).toBe(200);
    const apiListTestEntries = listResponse.jsonResponse.filter(
      (entry: any) => entry.title === "API List Test"
    );

    expect(apiListTestEntries.length).toBe(1); // Only latest version
    expect(apiListTestEntries[0].id).toBe(v3Response.jsonResponse.id);
    expect(apiListTestEntries[0].version).toBe(3);
    expect(apiListTestEntries[0].hidden).toBe(false);
    expect(apiListTestEntries[0].text).toBeUndefined(); // Text should not be in list

    // Cleanup
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
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v1Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("GET history endpoint should return all versions chronologically", async () => {
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

    const v2Response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v1Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 2",
      }
    );

    const v3Response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v2Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 3",
      }
    );

    // Get history
    const historyResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v3Response.jsonResponse.id}/history`,
      TEST_USER_1_TOKEN
    );

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.jsonResponse.length).toBe(3);

    // Check chronological order (oldest first)
    expect(historyResponse.jsonResponse[0].id).toBe(v1Response.jsonResponse.id);
    expect(historyResponse.jsonResponse[0].version).toBe(1);
    expect(historyResponse.jsonResponse[1].id).toBe(v2Response.jsonResponse.id);
    expect(historyResponse.jsonResponse[1].version).toBe(2);
    expect(historyResponse.jsonResponse[2].id).toBe(v3Response.jsonResponse.id);
    expect(historyResponse.jsonResponse[2].version).toBe(3);

    // Cleanup
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
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v1Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("GET history should work from any version in chain", async () => {
    const v1Response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 1",
        title: "History Chain Test",
      }
    );

    const v2Response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v1Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 2",
      }
    );

    const v3Response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v2Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Version 3",
      }
    );

    // Get history from v2 - should still return all 3 versions
    const historyResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v2Response.jsonResponse.id}/history`,
      TEST_USER_1_TOKEN
    );

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.jsonResponse.length).toBe(3);
    expect(historyResponse.jsonResponse[0].id).toBe(v1Response.jsonResponse.id);
    expect(historyResponse.jsonResponse[1].id).toBe(v2Response.jsonResponse.id);
    expect(historyResponse.jsonResponse[2].id).toBe(v3Response.jsonResponse.id);

    // Cleanup
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
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${v1Response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Parent-child hierarchy should persist when parent is updated (Bug Fix Test)", async () => {
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
    const parentV1Id = parentResponse.jsonResponse.id;
    const parentDocumentId = parentResponse.jsonResponse.documentId;

    // Create child entry pointing to parent
    const childResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Child text",
        title: "Child Entry",
        parentId: parentV1Id,
      }
    );

    expect(childResponse.status).toBe(200);
    const childId = childResponse.jsonResponse.id;
    // Child's parentId should be parent's documentId (not id!)
    expect(childResponse.jsonResponse.parentId).toBe(parentDocumentId);

    // Update parent (creates new version with new id)
    const parentUpdateResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${parentV1Id}`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Parent text v2",
        title: "Updated Parent Entry",
      }
    );

    expect(parentUpdateResponse.status).toBe(200);
    const parentV2Id = parentUpdateResponse.jsonResponse.id;
    expect(parentV2Id).not.toBe(parentV1Id); // New version has new id
    expect(parentUpdateResponse.jsonResponse.documentId).toBe(parentDocumentId); // Same documentId

    // Get child again - parentId should STILL point to parent's documentId
    const childCheckResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${childId}`,
      TEST_USER_1_TOKEN
    );

    expect(childCheckResponse.status).toBe(200);
    expect(childCheckResponse.jsonResponse.parentId).toBe(parentDocumentId); // Still valid!

    // Create another child using the updated parent's id
    const child2Response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "Second child text",
        title: "Second Child Entry",
        parentId: parentV2Id, // Use new version's id
      }
    );

    expect(child2Response.status).toBe(200);
    expect(child2Response.jsonResponse.parentId).toBe(parentDocumentId); // Also points to documentId

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
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${parentV2Id}`,
      TEST_USER_1_TOKEN
    );
  });
});
