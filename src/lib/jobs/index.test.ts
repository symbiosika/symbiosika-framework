import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  defineJob,
  createJob,
  getJob,
  startJobQueue,
  stopJobQueue,
  processJob,
} from ".";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

describe("Job Queue System", () => {
  beforeAll(async () => {
    await initTests();
  });

  // Bun runs every test file in one shared process, so a polling interval left
  // running here would keep processing jobs created by later test files and
  // could fail unrelated tests. Stop it once this suite is done.
  afterAll(() => {
    stopJobQueue();
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

  it("runs a job at most once when two cycles pick up the same job", async () => {
    // Reproduces the mass-import race: overlapping worker cycles (setInterval
    // does not wait for its async callback) — or two server instances — both
    // SELECT the same pending job and then both try to process it. The atomic
    // pending -> running claim in processJob must let only one of them actually
    // execute the handler, so a slow ingest job can't have its temporary upload
    // file deleted out from under a concurrent duplicate run ("File not found").
    //
    // The two cycles are simulated by handing the *same* pending job row to two
    // concurrent processJob() calls: that is exactly the post-SELECT state both
    // cycles are in. (Two concurrent processDueJobsOnce() drains would NOT
    // reproduce it here — PGlite serialises connections, so the second drain's
    // SELECT already sees the job as running and never reaches the claim.)
    let runs = 0;
    defineJob("claim-race-job", {
      async execute() {
        runs++;
        // Stay "running" a moment so both claim attempts overlap in JS land.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { runs };
      },
    });

    // Stop the background interval so only our explicit calls process the job.
    stopJobQueue();

    const job = await createJob(
      "claim-race-job",
      { test: true },
      TEST_ORGANISATION_1.id
    );

    // Both "cycles" hold the same pending job row and race to process it.
    await Promise.all([processJob(job), processJob(job)]);

    const completed = await getJob(job.id);
    expect(completed.status).toBe("completed");
    // Exactly one claim wins — the handler must have executed exactly once.
    expect(runs).toBe(1);
  }, 10000);
});
