import { describe, test, expect, beforeAll } from "bun:test";
import { testFetcher } from "../../../../../test/fetcher.test";
import defineRoutes from ".";
import { initTests, TEST_ORGANISATION_1 } from "../../../../../test/init.test";
import { Hono } from "hono";
import type { SFContextVariables } from "../../../../../types";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../../../../../lib/db/db-connection";
import { processDueJobsOnce, getJob } from "../../../../../lib/jobs";

let app = new Hono<{ Variables: SFContextVariables }>();
let TEST_USER_1_TOKEN: string;

/**
 * The import routes now return a Job. Run the just-created job to completion
 * (the built-in ingest handler is registered in `initTests`) and return the
 * `{ knowledgeText, blocks }` result stored on the job.
 */
const runImportJob = async (job: any) => {
  expect(job.id).toBeDefined();
  expect(job.type).toBe("knowledge:ingest");
  await processDueJobsOnce();
  const finished = await getJob(job.id);
  expect(finished.status).toBe("completed");
  return finished.result as any;
};

const SCOPE_ID = crypto.randomUUID();

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(app, "/api");
  const { user1Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
});

describe("Knowledge Text Import & Sync API", () => {
  test("POST import uploads a markdown file and creates a block page", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(
        ["# Imported Doc\n\nIntro.\n\n## Section\n\nDetails."],
        "imported-doc.md",
        { type: "text/markdown" }
      )
    );

    const response = await testFetcher.postFormData(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/import`,
      TEST_USER_1_TOKEN,
      form
    );

    expect(response.status).toBe(200);
    const result = await runImportJob(response.jsonResponse);
    expect(result.knowledgeText.title).toBe("imported-doc");
    expect(result.knowledgeText.contentMode).toBe("blocks");
    expect(result.blocks.length).toBe(2);
  }, 30000);

  test("POST import honors title and splitIntoBlocks fields", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["# One\n\n## Two"], "x.md", { type: "text/markdown" })
    );
    form.append("title", "My Custom Title");
    form.append("splitIntoBlocks", "false");

    const response = await testFetcher.postFormData(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/import`,
      TEST_USER_1_TOKEN,
      form
    );

    expect(response.status).toBe(200);
    const result = await runImportJob(response.jsonResponse);
    expect(result.knowledgeText.title).toBe("My Custom Title");
    expect(result.knowledgeText.contentMode).toBe("text");
  }, 30000);

  test("POST import without a file returns 400", async () => {
    const form = new FormData();
    form.append("title", "no file");

    const response = await testFetcher.postFormData(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/import`,
      TEST_USER_1_TOKEN,
      form
    );
    expect(response.status).toBe(400);
  });

  test("POST import-url rejects an invalid url", async () => {
    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/import-url`,
      TEST_USER_1_TOKEN,
      { url: "not-a-url" }
    );
    expect(response.status).toBe(400);
  });

  test("POST sync upserts items and reports per-item results", async () => {
    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/sync`,
      TEST_USER_1_TOKEN,
      {
        items: [
          {
            sourceIdentifier: "api-doc-1",
            title: "API Synced Doc 1",
            text: "content 1",
          },
          {
            sourceIdentifier: "api-doc-2",
            title: "API Synced Doc 2",
            text: "content 2",
          },
        ],
        matchScope: { syncConfigId: SCOPE_ID },
      }
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.results.length).toBe(2);
    expect(response.jsonResponse.results[0].created).toBe(true);
    expect(response.jsonResponse.orphansDeleted).toBe(0);
  });

  test("POST sync again: unchanged items are no-ops, orphans get cleaned", async () => {
    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/sync`,
      TEST_USER_1_TOKEN,
      {
        items: [
          {
            sourceIdentifier: "api-doc-1",
            title: "API Synced Doc 1",
            text: "content 1",
          },
          // api-doc-2 vanished from the source
        ],
        matchScope: { syncConfigId: SCOPE_ID },
        deleteOrphans: true,
      }
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.results[0].created).toBe(false);
    expect(response.jsonResponse.results[0].changed).toBe(false);
    expect(response.jsonResponse.orphansDeleted).toBe(1);
  });

  test("POST sync validates the payload", async () => {
    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/sync`,
      TEST_USER_1_TOKEN,
      { items: [{ sourceIdentifier: "", title: "", text: "x" }] }
    );
    expect(response.status).toBe(400);
  });
});
