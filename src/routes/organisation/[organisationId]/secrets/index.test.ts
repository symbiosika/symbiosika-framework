import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import defineManageSecretsRoutes from ".";
import type { FastAppHono } from "../../../../types";
import { initTests, TEST_ORGANISATION_1 } from "../../../../test/init.test";
import { testFetcher } from "../../../../test/fetcher.test";

let userOrg1Token: string;
let userOrg2Token: string;
const app: FastAppHono = new Hono();

describe("Secrets API Endpoints", () => {
  let jwt: string;

  beforeAll(async () => {
    await initTests();
    const { user1Token, user2Token } = await initTests();
    userOrg1Token = user1Token;
    userOrg2Token = user2Token;
    defineManageSecretsRoutes(app, "/api");
  });

  // Test getting secrets
  test("should get all secrets", async () => {
    const response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets`,
      userOrg1Token
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.jsonResponse)).toBe(true);
  });

  // Test setting a new secret
  test("should set a new secret", async () => {
    const secretData = {
      name: "TEST_SECRET",
      value: "test_value_123",
    };

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets`,
      userOrg1Token,
      secretData
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse?.name).toBe("TEST_SECRET");
  });

  // Test deleting a secret
  test("should delete a secret", async () => {
    // First create a secret to delete
    const secretData = {
      name: "SECRET_TO_DELETE",
      value: "delete_me",
    };

    const createResponse = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets`,
      userOrg1Token,
      secretData
    );
    expect(createResponse.status).toBe(200);

    // Now delete the secret
    const deleteResponse = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets/SECRET_TO_DELETE`,
      userOrg1Token
    );
    expect(deleteResponse.status).toBe(200);

    // Verify the secret is deleted by trying to fetch it
    const verifyResponse = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets/SECRET_TO_DELETE`,
      userOrg1Token
    );
    expect(verifyResponse.status).toBe(404);
  });

  // Test error cases
  test("should handle invalid requests", async () => {
    // Test unauthorized access
    const unauthorizedResponse = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets`,
      userOrg2Token
    );
    expect(unauthorizedResponse.status).toBe(403);

    // Test invalid secret data
    const invalidSecretResponse = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets`,
      userOrg1Token,
      {
        name: 123, // Should be string
        value: true, // Should be string
      }
    );
    expect(invalidSecretResponse.status).toBe(400);

    // Test invalid secret data format
    const invalidFormatResponse = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets`,
      userOrg1Token,
      {
        name: 123, // Should be string
        value: true, // Should be string
      }
    );
    expect(invalidFormatResponse.status).toBe(400);

    // Test deleting non-existent secret
    const nonExistentResponse = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets/NON_EXISTENT_SECRET`,
      userOrg1Token
    );
    expect(nonExistentResponse.status).toBe(200);
  });
});

describe("Security checks for Secrets API Endpoints", () => {
  // Test unauthorized access to another organisation's secrets
  test("should not allow user from another organisation to get secrets", async () => {
    const response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets`,
      userOrg2Token
    );

    expect(response.status).toBe(403); // Assuming 403 Forbidden for unauthorized access
  });

  test("should not allow user from another organisation to set a secret", async () => {
    const secretData = {
      name: "UNAUTHORIZED_SECRET",
      value: "unauthorized_value",
    };

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets`,
      userOrg2Token,
      secretData
    );

    expect(response.status).toBe(403);
  });

  test("should not allow user from another organisation to delete a secret", async () => {
    const response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/secrets/SECRET_TO_DELETE`,
      userOrg2Token
    );

    expect(response.status).toBe(403);
  });
});
