import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { testFetcher } from "../../../../test/fetcher.test";
import defineJobRoutes from "./index";
import { initTests, TEST_ORGANISATION_1 } from "../../../../test/init.test";
import { Hono } from "hono";
import type { SymbiosikaFrameworkHonoAppContextVariables } from "../../../../types";
import { getDb } from "../../../../lib/db/db-connection";
import { jobs } from "../../../../lib/db/db-schema";
import { eq, or } from "drizzle-orm";

let app = new Hono<{ Variables: SymbiosikaFrameworkHonoAppContextVariables }>();
let TEST_USER_1_TOKEN: string;
let TEST_USER_2_TOKEN: string;
let TEST_USER_3_TOKEN: string;

let jobId: string;

describe("Jobs API Endpoints", () => {
  beforeAll(async () => {
    defineJobRoutes(app, "/api");
    const { user1Token, user2Token, user3Token } = await initTests();
    TEST_USER_1_TOKEN = user1Token;
    TEST_USER_2_TOKEN = user2Token;
    TEST_USER_3_TOKEN = user3Token;
  });

  afterAll(async () => {
    getDb()
      .delete(jobs)
      .where(or(eq(jobs.type, "test-job"), eq(jobs.type, "lifecycle-test")));
  });

  test("Sequential Job Operations", async () => {
    console.log("Testing sequential job operations...");

    console.log("Creating a new job...");
    let response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs`,
      TEST_USER_1_TOKEN,
      {
        type: "test-job",
        metadata: { testData: "test value" },
      }
    );
    expect(response.status).toBe(200);
    let data = response.jsonResponse;
    jobId = data.id;
    console.log("Created job:", jobId);
    expect(data.type).toBe("test-job");
    expect(data.status).toBe("pending");
    expect(data.tenantId).toBe(TEST_ORGANISATION_1.id);

    console.log("Getting all jobs...");
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((job: any) => job.id === jobId)).toBe(true);

    console.log("Getting job by ID...");
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.id).toBe(jobId);
    expect(data.type).toBe("test-job");

    console.log("Getting job status...");
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}/status`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.status).toBe("pending");

    console.log("Updating job progress...");
    response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}/progress`,
      TEST_USER_1_TOKEN,
      { progress: 50 }
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.id).toBe(jobId);

    console.log("Checking updated job status with progress...");
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}/status`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.status).toBe("pending");
    expect(data.progress).toBe(50);

    console.log("Cancelling job...");
    response = await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);

    console.log("Verifying job was cancelled...");
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.status).toBe("failed");
  });

  test("Job Filtering and Querying", async () => {
    console.log("Testing job filtering and querying...");

    // Create multiple jobs with different types and statuses
    console.log("Creating test jobs with different types...");

    // Create first job - type A
    let response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs`,
      TEST_USER_1_TOKEN,
      {
        type: "job-type-A",
        metadata: { testData: "A" },
      }
    );
    expect(response.status).toBe(200);
    const jobA = response.jsonResponse.id;

    // Create second job - type B
    response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs`,
      TEST_USER_1_TOKEN,
      {
        type: "job-type-B",
        metadata: { testData: "B" },
      }
    );
    expect(response.status).toBe(200);
    const jobB = response.jsonResponse.id;

    // Create third job - type A again
    response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs`,
      TEST_USER_1_TOKEN,
      {
        type: "job-type-A",
        metadata: { testData: "A2" },
      }
    );
    expect(response.status).toBe(200);
    const jobA2 = response.jsonResponse.id;

    console.log("Testing filtering by type...");
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs?type=job-type-A`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    let data = response.jsonResponse;
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((job: any) => job.id === jobA)).toBe(true);
    expect(data.some((job: any) => job.id === jobA2)).toBe(true);
    expect(data.some((job: any) => job.id === jobB)).toBe(false);

    console.log("Testing filtering by status...");
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs?status=pending`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(Array.isArray(data)).toBe(true);
    expect(data.every((job: any) => job.status === "pending")).toBe(true);

    console.log("Testing pagination with limit...");
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs?limit=2`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeLessThanOrEqual(2);

    // Clean up jobs
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobA}`,
      TEST_USER_1_TOKEN
    );
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobB}`,
      TEST_USER_1_TOKEN
    );
    await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobA2}`,
      TEST_USER_1_TOKEN
    );
  });

  test("Job Lifecycle", async () => {
    console.log("Testing job lifecycle...");

    // Create a job
    let response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs`,
      TEST_USER_1_TOKEN,
      {
        type: "lifecycle-test",
        metadata: { initialData: "start" },
      }
    );
    expect(response.status).toBe(200);
    jobId = response.jsonResponse.id;

    // Verify initial state
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}/status`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    let data = response.jsonResponse;
    expect(data.status).toBe("pending");

    // Update progress to 25%
    response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}/progress`,
      TEST_USER_1_TOKEN,
      { progress: 25 }
    );
    expect(response.status).toBe(200);

    // Verify progress updated
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}/status`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.progress).toBe(25);

    // Update progress to 50%
    response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}/progress`,
      TEST_USER_1_TOKEN,
      { progress: 50 }
    );
    expect(response.status).toBe(200);

    // Verify progress updated
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}/status`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.progress).toBe(50);

    // Update progress to 100%
    response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}/progress`,
      TEST_USER_1_TOKEN,
      { progress: 100 }
    );
    expect(response.status).toBe(200);

    // Verify progress updated
    response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/jobs/${jobId}/status`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.progress).toBe(100);
  });
});
