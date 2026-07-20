import { describe, it, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import {
  defineJob,
  createJob,
  processDueJobsOnce,
} from ".";
import { getDb } from "../db/db-connection";
import { jobs } from "../db/schema/jobs";
import { getUserMessages } from "../notifications";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../../test/init.test";

/**
 * Verifies the opt-in bridge between the job queue and the user notification
 * queue: a job created with `metadata.notifyOnCompletion` pushes a
 * success/error message into the owning user's queue when it finishes.
 */
describe("Job completion → user notification", () => {
  beforeAll(async () => {
    await initTests();

    defineJob("notify-ok-test", {
      async execute() {
        return { ok: true };
      },
    });
    defineJob("notify-fail-test", {
      async execute() {
        throw new Error("boom");
      },
    });
  });

  const createOwnedJob = async (type: string, metadata: any) => {
    const job = await createJob(type, metadata, TEST_ORGANISATION_1.id);
    await getDb()
      .update(jobs)
      .set({ userId: TEST_ORG1_USER_1.id })
      .where(eq(jobs.id, job.id));
    return job;
  };

  it("pushes a success message when a job completes", async () => {
    const job = await createOwnedJob("notify-ok-test", {
      notifyOnCompletion: true,
    });

    await processDueJobsOnce();

    const messages = await getUserMessages(TEST_ORG1_USER_1.id);
    const msg = messages.find((m) => (m.meta as any)?.jobId === job.id);
    expect(msg).toBeDefined();
    expect(msg!.messageType).toBe("success");
    expect((msg!.meta as any).jobType).toBe("notify-ok-test");
    expect((msg!.meta as any).status).toBe("completed");
  }, 30000);

  it("pushes an error message when a job fails", async () => {
    const job = await createOwnedJob("notify-fail-test", {
      notifyOnCompletion: true,
    });

    await processDueJobsOnce();

    const messages = await getUserMessages(TEST_ORG1_USER_1.id);
    const msg = messages.find((m) => (m.meta as any)?.jobId === job.id);
    expect(msg).toBeDefined();
    expect(msg!.messageType).toBe("error");
    expect(msg!.message).toContain("boom");
    expect((msg!.meta as any).status).toBe("failed");
  }, 30000);

  it("does not notify when the flag is not set", async () => {
    const job = await createOwnedJob("notify-ok-test", {});

    await processDueJobsOnce();

    const messages = await getUserMessages(TEST_ORG1_USER_1.id);
    const msg = messages.find((m) => (m.meta as any)?.jobId === job.id);
    expect(msg).toBeUndefined();
  }, 30000);
});
