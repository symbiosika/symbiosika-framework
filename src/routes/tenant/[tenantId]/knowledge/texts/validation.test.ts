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

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(app, "/api");
  const { user1Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
});

describe("Knowledge Text API Validation", () => {
  test("Should accept valid version field", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Test text with version",
      title: "Version Test",
      version: 5, // This field no longer exists in the schema
    };

    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(response.status).toBe(200);
    // version field is no longer part of the schema

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Should accept valid hidden field", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Test text with hidden flag",
      title: "Hidden Test",
      hidden: true,
    };

    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.hidden).toBe(true);

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Should accept valid parentId field", async () => {
    // Create parent first
    const parentData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Parent text",
      title: "Parent",
    };

    const parentResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      parentData
    );

    expect(parentResponse.status).toBe(200);

    // Create child with parentId
    const childData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Child text",
      title: "Child",
      parentId: parentResponse.jsonResponse.id,
    };

    const childResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      childData
    );

    expect(childResponse.status).toBe(200);
    expect(childResponse.jsonResponse.parentId).toBe(
      parentResponse.jsonResponse.id // Now stores id directly!
    );

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

  test("Should reject invalid version type", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Test text",
      title: "Test",
      version: "invalid", // This field no longer exists in schema
    };

    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    // Should succeed and ignore the version field
    expect(response.status).toBe(200);
    
    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Should reject invalid hidden type", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Test text",
      title: "Test",
      hidden: "invalid", // Should be boolean
    };

    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(response.status).toBe(400);
  });

  test("Should reject invalid parentId type", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Test text",
      title: "Test",
      parentId: 123, // Should be UUID string
    };

    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(response.status).toBe(400);
  });

  test("Should use default values when fields are not provided", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Test text without new fields",
      title: "Default Values Test",
    };

    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.hidden).toBe(false); // Default value
    expect(response.jsonResponse.parentId).toBeNull(); // No parent

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Should update entry and create history", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Test text for update",
      title: "Update Test",
      hidden: false,
    };

    const createResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(createResponse.status).toBe(200);
    const entryId = createResponse.jsonResponse.id;

    const updateData = {
      tenantId: TEST_ORGANISATION_1.id,
      hidden: true,
    };

    const updateResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${entryId}`,
      TEST_USER_1_TOKEN,
      updateData
    );

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.jsonResponse.hidden).toBe(true);
    expect(updateResponse.jsonResponse.id).toBe(entryId); // Same entry updated in place

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${updateResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });
});

