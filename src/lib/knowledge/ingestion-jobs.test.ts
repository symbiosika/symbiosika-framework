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
} from "./ingestion-jobs";

/**
 * These tests exercise the document-ingestion job pipeline end-to-end without
 * the HTTP layer: create a `knowledge:ingest` job, drain the queue once, and
 * assert the job completed with a knowledge-entry result.
 *
 * The built-in handler is registered inside `initTests`, and the queue is
 * drained deterministically via `processDueJobsOnce` (no background worker).
 */
describe("Knowledge ingestion jobs", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("runs a rag-text ingest job to completion", async () => {
    const job = await createKnowledgeIngestJob(
      {
        kind: "rag-text",
        tenantId: TEST_ORGANISATION_1.id,
        params: {
          text: "Symbiosika ingestion job unit test content about widgets.",
          title: "Ingest Job Text Test",
        },
      },
      TEST_ORGANISATION_1.id
    );

    expect(job.type).toBe(KNOWLEDGE_INGEST_JOB_TYPE);
    expect(job.status).toBe("pending");

    await processDueJobsOnce();

    const finished = await getJob(job.id);
    expect(finished.status).toBe("completed");
    expect((finished.result as any)?.ok).toBe(true);
    expect((finished.result as any)?.id).toBeDefined();
  }, 30000);

  it("runs a rag-upload ingest job from a stored file and cleans it up", async () => {
    const file = new File(
      ["Uploaded plain text document for the ingestion job test."],
      "ingest-upload-test.txt",
      { type: "text/plain" }
    );
    const storage = await storeIngestFileInDb(file, TEST_ORGANISATION_1.id);
    expect(storage.fileId).toBeDefined();

    const job = await createKnowledgeIngestJob(
      {
        kind: "rag-upload",
        tenantId: TEST_ORGANISATION_1.id,
        storage,
        deleteAfter: true,
        options: {},
      },
      TEST_ORGANISATION_1.id
    );

    await processDueJobsOnce();

    const finished = await getJob(job.id);
    expect(finished.status).toBe("completed");
    expect((finished.result as any)?.id).toBeDefined();
  }, 30000);

  it("marks a job as failed when the source does not exist", async () => {
    const job = await createKnowledgeIngestJob(
      {
        kind: "rag-existing",
        tenantId: TEST_ORGANISATION_1.id,
        params: {
          sourceType: "text",
          sourceId: "00000000-0000-0000-0000-000000000000",
        },
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
        kind: "rag-existing",
        tenantId: TEST_ORGANISATION_1.id,
        userId: TEST_ORG1_USER_1.id,
        notifyOnCompletion: true,
        params: {
          sourceType: "text",
          sourceId: "00000000-0000-0000-0000-000000000000",
        },
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
