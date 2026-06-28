import { describe, it, expect, beforeAll } from "bun:test";
import { defineJob, createJob, getJob, startJobQueue } from ".";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

describe("Job Queue System", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("should execute a job and update the database", async () => {
    // Define a test job handler
    defineJob("test-job", {
      async execute(metadata: any) {
        return { testValue: "completed" };
      },
    });

    // Start the job queue
    startJobQueue();

    // Create and start the job
    const job = await createJob(
      "test-job",
      { test: true },
      TEST_ORGANISATION_1.id
    );
    if (!job) {
      throw new Error("Job is undefined");
    }

    // Wait for job to complete (slightly longer than CHECK_CYCLE_MS)
    await new Promise((resolve) => setTimeout(resolve, 6000));

    // Check the job status
    const completedJob = await getJob(job.id);

    expect(completedJob).toBeDefined();
    if (!completedJob) return;
    expect(completedJob.status).toBe("completed");
    expect(completedJob.result).toEqual({ testValue: "completed" });
  }, 10000); // Increase timeout to allow for job processing

  it("should respect the scheduledAt timestamp", async () => {
    // Define a test job handler
    defineJob("scheduled-test-job", {
      async execute() {
        return { testValue: "scheduled-completed" };
      },
    });

    // Start the job queue (idempotent enough for tests)
    startJobQueue();

    // A job scheduled in the past must run, a job scheduled in the future must
    // stay pending.
    const pastJob = await createJob(
      "scheduled-test-job",
      { test: true },
      TEST_ORGANISATION_1.id,
      new Date(Date.now() - 60_000).toISOString()
    );
    const futureJob = await createJob(
      "scheduled-test-job",
      { test: true },
      TEST_ORGANISATION_1.id,
      new Date(Date.now() + 60 * 60_000).toISOString()
    );

    // Wait for at least one worker cycle to pass
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const past = await getJob(pastJob.id);
    const future = await getJob(futureJob.id);

    expect(past.status).toBe("completed");
    expect(past.result).toEqual({ testValue: "scheduled-completed" });

    // The future job must not have been picked up yet
    expect(future.status).toBe("pending");
  }, 10000);
});
