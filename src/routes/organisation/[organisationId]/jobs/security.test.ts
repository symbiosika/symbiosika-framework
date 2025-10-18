import { describe, test, expect, beforeAll } from "bun:test";
import { testFetcher } from "../../../../test/fetcher.test";
import defineJobRoutes from "./index";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORGANISATION_2,
} from "../../../../test/init.test";
import { Hono } from "hono";
import type { FastAppHonoContextVariables } from "../../../../types";

let app = new Hono<{ Variables: FastAppHonoContextVariables }>();
let TEST_USER_1_TOKEN: string;
let TEST_USER_2_TOKEN: string;
let TEST_USER_3_TOKEN: string;
let createdJobId: string;

beforeAll(async () => {
  defineJobRoutes(app, "/api");
  const { user1Token, user2Token, user3Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
  TEST_USER_2_TOKEN = user2Token;
  TEST_USER_3_TOKEN = user3Token;

  // Create a test job to use in security tests
  const response = await testFetcher.post(
    app,
    `/api/organisation/${TEST_ORGANISATION_1.id}/jobs`,
    TEST_USER_1_TOKEN,
    {
      type: "security-test-job",
      metadata: { securityTest: true },
    }
  );
  createdJobId = response.jsonResponse.id;
});

describe("Jobs API Security Tests", () => {
  test("Organisation Access Control", async () => {
    console.log("Testing organisation access control...");

    // User from a different organisation should not be able to access jobs
    console.log(
      "User from different organisation attempting to access jobs..."
    );
    let response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/jobs`,
      TEST_USER_2_TOKEN
    );
    expect(response.status).toBe(403);
    expect(response.textResponse).toContain("User is not a member of this organisation");

    // User from a different organisation should not be able to access a specific job
    console.log(
      "User from different organisation attempting to access specific job..."
    );
    response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/jobs/${createdJobId}`,
      TEST_USER_2_TOKEN
    );
    expect(response.status).toBe(403);
    expect(response.textResponse).toContain("User is not a member of this organisation");

    // User from a different organisation should not be able to create a job
    console.log(
      "User from different organisation attempting to create a job..."
    );
    response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/jobs`,
      TEST_USER_2_TOKEN,
      {
        type: "unauthorized-job",
        metadata: { unauthorized: true },
      }
    );
    expect(response.status).toBe(403);
    expect(response.textResponse).toContain("User is not a member of this organisation");

    // User from a different organisation should not be able to update job progress
    console.log(
      "User from different organisation attempting to update job progress..."
    );
    response = await testFetcher.put(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/jobs/${createdJobId}/progress`,
      TEST_USER_2_TOKEN,
      { progress: 75 }
    );
    expect(response.status).toBe(403);
    expect(response.textResponse).toContain("User is not a member of this organisation");

    // User from a different organisation should not be able to cancel a job
    console.log(
      "User from different organisation attempting to cancel a job..."
    );
    response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/jobs/${createdJobId}`,
      TEST_USER_2_TOKEN
    );
    expect(response.status).toBe(403);
    expect(response.textResponse).toContain("User is not a member of this organisation");
  });

  test("Cross-Organisation Job Access", async () => {
    console.log("Testing cross-organisation job access...");

    // Create a job in organisation 2
    console.log("Creating job in organisation 2...");
    let response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_2.id}/jobs`,
      TEST_USER_2_TOKEN,
      {
        type: "org2-job",
        metadata: { org2Data: true },
      }
    );
    expect(response.status).toBe(200);
    const org2JobId = response.jsonResponse.id;

    // User from organisation 1 should not be able to access job from organisation 2
    console.log("User from org1 attempting to access job from org2...");
    response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_2.id}/jobs/${org2JobId}`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(403);
    expect(response.textResponse).toContain("User is not a member of this organisation");

    // User from organisation 1 should not be able to update job from organisation 2
    console.log("User from org1 attempting to update job from org2...");
    response = await testFetcher.put(
      app,
      `/api/organisation/${TEST_ORGANISATION_2.id}/jobs/${org2JobId}/progress`,
      TEST_USER_1_TOKEN,
      { progress: 30 }
    );
    expect(response.status).toBe(403);
    expect(response.textResponse).toContain("User is not a member of this organisation");

    // User from organisation 1 should not be able to cancel job from organisation 2
    console.log("User from org1 attempting to cancel job from org2...");
    response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_2.id}/jobs/${org2JobId}`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(403);
    expect(response.textResponse).toContain("User is not a member of this organisation");

    // Clean up - cancel the job from org2
    await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_2.id}/jobs/${org2JobId}`,
      TEST_USER_2_TOKEN
    );
  });

  test("Invalid Job ID Access", async () => {
    console.log("Testing invalid job ID access...");

    // Attempt to access a non-existent job
    console.log("Attempting to access non-existent job...");
    const nonExistentJobId = "00000000-0000-0000-0000-000000000000";

    let response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/jobs/${nonExistentJobId}`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(404);
    expect(response.textResponse).toContain("Job not found");

    // Attempt to update progress of a non-existent job
    console.log("Attempting to update progress of non-existent job...");
    response = await testFetcher.put(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/jobs/${nonExistentJobId}/progress`,
      TEST_USER_1_TOKEN,
      { progress: 50 }
    );
    expect(response.status).toBe(404);
    expect(response.textResponse).toContain("Job not found");

    // Attempt to cancel a non-existent job
    console.log("Attempting to cancel non-existent job...");
    response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/jobs/${nonExistentJobId}`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(404);
    expect(response.textResponse).toContain("Job not found");
  });

  test("Job Organisation Mismatch", async () => {
    console.log("Testing job organisation mismatch...");

    // Attempt to access a job using the wrong organisation ID
    console.log("Attempting to access job with wrong organisation ID...");
    let response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_2.id}/jobs/${createdJobId}`,
      TEST_USER_2_TOKEN
    );
    expect(response.status).toBe(404);
    expect(response.textResponse).toContain("Job not found");

    // Attempt to update progress of a job using the wrong organisation ID
    console.log(
      "Attempting to update job progress with wrong organisation ID..."
    );
    response = await testFetcher.put(
      app,
      `/api/organisation/${TEST_ORGANISATION_2.id}/jobs/${createdJobId}/progress`,
      TEST_USER_2_TOKEN,
      { progress: 50 }
    );
    expect(response.status).toBe(404);
    expect(response.textResponse).toContain("Job not found");

    // Attempt to cancel a job using the wrong organisation ID
    console.log("Attempting to cancel job with wrong organisation ID...");
    response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_2.id}/jobs/${createdJobId}`,
      TEST_USER_2_TOKEN
    );
    expect(response.status).toBe(404);
    expect(response.textResponse).toContain("Job not found");
  });

  // Clean up the test job created in beforeAll
  test("Clean Up", async () => {
    console.log("Cleaning up test job...");
    await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/jobs/${createdJobId}`,
      TEST_USER_1_TOKEN
    );
  });
});
