import { describe, test, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { testFetcher } from "../../../../../test/fetcher.test";
import defineRoutes from ".";
import { initTests, TEST_ORGANISATION_1 } from "../../../../../test/init.test";
import { Hono } from "hono";
import type { SFContextVariables } from "../../../../../types";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../../../../../lib/db/db-connection";
import { getDb } from "../../../../../lib/db/db-connection";
import { files } from "../../../../../lib/db/schema/files";

let app = new Hono<{ Variables: SFContextVariables }>();
let TEST_USER_1_TOKEN: string;
let pageId: string;
let uploadedFileId: string;
let uploadedMarkdown: string;

const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(app, "/api");
  const { user1Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
});

describe("Wiki Image Upload API (editor flow)", () => {
  test("Setup: create a page", async () => {
    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        title: "Image API Page",
        text: "",
      }
    );
    expect(response.status).toBe(200);
    pageId = response.jsonResponse.id;
  });

  test("POST images uploads and returns a markdown snippet", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([PNG_BYTES], "diagram.png", { type: "image/png" })
    );
    form.append("alt", "architecture diagram");

    const response = await testFetcher.postFormData(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${pageId}/images`,
      TEST_USER_1_TOKEN,
      form
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.fileId).toBeDefined();
    expect(response.jsonResponse.markdown).toContain(
      "![architecture diagram]("
    );
    expect(response.jsonResponse.path).toContain("/files/db/wiki/");

    uploadedFileId = response.jsonResponse.fileId;
    uploadedMarkdown = response.jsonResponse.markdown;
  });

  test("Embedding the image via block save makes it permanent", async () => {
    const response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${pageId}/blocks`,
      TEST_USER_1_TOKEN,
      {
        blocks: [
          { type: "markdown", content: `# Doc\n\n${uploadedMarkdown}` },
        ],
      }
    );
    expect(response.status).toBe(200);

    const rows = await getDb()
      .select({ expiresAt: files.expiresAt })
      .from(files)
      .where(eq(files.id, uploadedFileId));
    expect(rows[0]?.expiresAt).toBeNull();
  });

  test("Removing the image via block save schedules cleanup", async () => {
    const response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${pageId}/blocks`,
      TEST_USER_1_TOKEN,
      { blocks: [{ type: "markdown", content: "# Doc without image" }] }
    );
    expect(response.status).toBe(200);

    const rows = await getDb()
      .select({ expiresAt: files.expiresAt })
      .from(files)
      .where(eq(files.id, uploadedFileId));
    expect(rows[0]?.expiresAt).not.toBeNull();
  });

  test("POST images rejects non-image files", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["hello"], "notes.txt", { type: "text/plain" })
    );

    const response = await testFetcher.postFormData(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${pageId}/images`,
      TEST_USER_1_TOKEN,
      form
    );
    expect(response.status).toBe(400);
  });

  test("POST images on an unknown page returns 404", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([PNG_BYTES], "x.png", { type: "image/png" })
    );

    const response = await testFetcher.postFormData(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${crypto.randomUUID()}/images`,
      TEST_USER_1_TOKEN,
      form
    );
    expect(response.status).toBe(404);
  });
});
