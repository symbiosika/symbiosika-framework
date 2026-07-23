import { describe, it, expect, beforeAll } from "bun:test";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../../test/init.test";
import { processDueJobsOnce, getJob } from "../jobs";
import { getUserMessages } from "../notifications";
import {
  createKnowledgeIngestJob,
  storeIngestFileInDb,
  KNOWLEDGE_INGEST_JOB_TYPE,
  KNOWLEDGE_INGEST_BUCKET,
} from "./ingestion-jobs";

/**
 * These tests exercise the document-ingestion job pipeline end-to-end without
 * the HTTP layer: create a `knowledge:ingest` job, drain the queue once, and
 * assert the job completed with a wiki-page result.
 *
 * The built-in handler is registered inside `initTests`, and the queue is
 * drained deterministically via `processDueJobsOnce` (no background worker).
 */
describe("Knowledge ingestion jobs", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("runs a text-import-file ingest job to completion", async () => {
    const file = new File(["# Title\n\nSome imported content."], "ingest-job-test.md", {
      type: "text/markdown",
    });
    const storage = await storeIngestFileInDb(file, TEST_ORGANISATION_1.id);
    expect(storage.fileId).toBeDefined();

    const job = await createKnowledgeIngestJob(
      {
        kind: "text-import-file",
        tenantId: TEST_ORGANISATION_1.id,
        storage,
        deleteAfter: true,
        options: {},
      },
      TEST_ORGANISATION_1.id
    );

    expect(job.type).toBe(KNOWLEDGE_INGEST_JOB_TYPE);
    expect(job.status).toBe("pending");

    await processDueJobsOnce();

    const finished = await getJob(job.id);
    expect(finished.status).toBe("completed");
    expect((finished.result as any)?.knowledgeText?.id).toBeDefined();
  }, 30000);

  it("marks a job as failed when the source file does not exist", async () => {
    const job = await createKnowledgeIngestJob(
      {
        kind: "text-import-file",
        tenantId: TEST_ORGANISATION_1.id,
        storage: {
          storageType: "db",
          bucket: KNOWLEDGE_INGEST_BUCKET,
          fileId: "00000000-0000-0000-0000-000000000000",
          fileName: "missing.md",
        },
        deleteAfter: true,
        options: {},
      },
      TEST_ORGANISATION_1.id
    );

    await processDueJobsOnce();

    const finished = await getJob(job.id);
    expect(finished.status).toBe("failed");
    expect((finished.error as any)?.message).toBeDefined();
  }, 30000);

  it("notifies the user when notifyOnCompletion is set and the job fails", async () => {
    const job = await createKnowledgeIngestJob(
      {
        kind: "text-import-file",
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
        notifyOnCompletion: true,
        storage: {
          storageType: "db",
          bucket: KNOWLEDGE_INGEST_BUCKET,
          fileId: "00000000-0000-0000-0000-000000000000",
          fileName: "missing.md",
        },
        deleteAfter: true,
        options: {},
      },
      TEST_ORGANISATION_1.id,
      TEST_ORG1_USER_1.id
    );

    await processDueJobsOnce();

    const messages = await getUserMessages(TEST_ORG1_USER_1.id);
    const msg = messages.find((m) => (m.meta as any)?.jobId === job.id);
    expect(msg).toBeDefined();
    expect(msg!.messageType).toBe("error");
    expect((msg!.meta as any).jobType).toBe(KNOWLEDGE_INGEST_JOB_TYPE);
    expect((msg!.meta as any).status).toBe("failed");
  }, 30000);
});
