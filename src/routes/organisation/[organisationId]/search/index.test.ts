import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import defineSearchInOrganisationRoutes from ".";
import type { FastAppHono } from "../../../../types";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../../../../test/init.test";
import { testFetcher } from "../../../../test/fetcher.test";

const app: FastAppHono = new Hono();
let userOrg1Token: string;
let userOrg2Token: string;

describe("Search API Endpoints", () => {
  beforeAll(async () => {
    await initTests();
    defineSearchInOrganisationRoutes(app, "/api");
    const { user1Token, user2Token } = await initTests();
    userOrg1Token = user1Token;
    userOrg2Token = user2Token;
  });

  // Test searching for a user by email
  test("should find TEST_ORG1_USER_1 in ORGANISATION_1", async () => {
    const response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/search/user?email=${TEST_ORG1_USER_1.email}`,
      userOrg1Token
    );
    // console.log(response.textResponse);
    expect(response.status).toBe(200);
    expect(response.jsonResponse?.email).toBe(TEST_ORG1_USER_1.email);
  });

  // Test searching for a user not in the organisation
  test("should not find TEST_ORG1_USER_1 in ORGANISATION_2", async () => {
    const response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/search/user?email=${TEST_ORG1_USER_1.email}`,
      userOrg2Token
    );
    console.log(response.textResponse);
    expect(response.status).toBe(403);
    expect(response.textResponse).toContain(
      "User is not a member of this organisation"
    );
  });

  // Test unauthorized access
  test("should not allow unauthorized access to search", async () => {
    const response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/search/user?email=${TEST_ORG1_USER_1.email}`,
      undefined
    );
    // console.log(response.textResponse);
    expect(response.status).toBe(401); // Assuming 401 Unauthorized for missing token
  });
});
