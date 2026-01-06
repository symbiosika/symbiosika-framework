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
      version: 5,
    };

    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.version).toBe(5);

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
      parentResponse.jsonResponse.id
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
      version: "invalid", // Should be number
    };

    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      textData
    );

    expect(response.status).toBe(400);
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
    expect(response.jsonResponse.version).toBe(1); // Default value
    expect(response.jsonResponse.hidden).toBe(false); // Default value
    expect(response.jsonResponse.parentId).toBeNull(); // No parent

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${response.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Should allow updating version and hidden via PUT", async () => {
    const textData = {
      tenantId: TEST_ORGANISATION_1.id,
      text: "Test text for update",
      title: "Update Test",
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
      version: 2,
      hidden: true,
    };

    const updateResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN,
      updateData
    );

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.jsonResponse.version).toBe(2);
    expect(updateResponse.jsonResponse.hidden).toBe(true);

    // Cleanup
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${createResponse.jsonResponse.id}`,
      TEST_USER_1_TOKEN
    );
  });
});

