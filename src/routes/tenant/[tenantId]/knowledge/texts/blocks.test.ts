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

let app = new Hono<{ Variables: SFContextVariables }>();
let TEST_USER_1_TOKEN: string;
let pageId: string;
let firstBlockId: string;
let secondBlockId: string;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(app, "/api");
  const { user1Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
});

describe("Knowledge Text Blocks API", () => {
  test("Create a page for block editing", async () => {
    const response = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "",
        title: "Blocks API Test Page",
      }
    );
    expect(response.status).toBe(200);
    expect(response.jsonResponse.contentMode).toBe("text");
    pageId = response.jsonResponse.id;
  });

  test("GET blocks of a fresh page returns an empty list", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${pageId}/blocks`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    expect(response.jsonResponse).toEqual([]);
  });

  test("PUT blocks creates the block list and materializes the text", async () => {
    const response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${pageId}/blocks`,
      TEST_USER_1_TOKEN,
      {
        blocks: [
          { type: "markdown", content: "# Wiki Page" },
          { type: "html", content: "<p>Rendered <em>rich</em> text</p>" },
        ],
      }
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.blocks.length).toBe(2);
    expect(response.jsonResponse.changes.inserted).toBe(2);
    expect(response.jsonResponse.knowledgeText.contentMode).toBe("blocks");
    expect(response.jsonResponse.knowledgeText.text).toContain("# Wiki Page");
    expect(response.jsonResponse.knowledgeText.text).toContain("_rich_");

    firstBlockId = response.jsonResponse.blocks[0].id;
    secondBlockId = response.jsonResponse.blocks[1].id;
  });

  test("GET blocks returns the saved blocks in order", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${pageId}/blocks`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    expect(response.jsonResponse.length).toBe(2);
    expect(response.jsonResponse[0].id).toBe(firstBlockId);
    expect(response.jsonResponse[1].id).toBe(secondBlockId);
  });

  test("PUT blocks reorders and edits in one save", async () => {
    const response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${pageId}/blocks`,
      TEST_USER_1_TOKEN,
      {
        blocks: [
          { id: secondBlockId, type: "html", content: "<p>Now first</p>" },
          { id: firstBlockId, type: "markdown", content: "# Now second" },
        ],
      }
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.blocks[0].id).toBe(secondBlockId);
    expect(response.jsonResponse.blocks[1].id).toBe(firstBlockId);
    expect(response.jsonResponse.changes.deleted).toBe(0);
  });

  test("PUT blocks rejects an invalid block type", async () => {
    const response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${pageId}/blocks`,
      TEST_USER_1_TOKEN,
      {
        blocks: [{ type: "video", content: "nope" }],
      }
    );
    expect(response.status).toBe(400);
  });

  test("PUT blocks on an unknown page returns 404", async () => {
    const response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${crypto.randomUUID()}/blocks`,
      TEST_USER_1_TOKEN,
      { blocks: [] }
    );
    expect(response.status).toBe(404);
  });

  test("Convert a legacy text page to blocks", async () => {
    const createResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "# Legacy page\n\nwith old content",
        title: "Legacy Conversion Test",
      }
    );
    expect(createResponse.status).toBe(200);
    const legacyId = createResponse.jsonResponse.id;

    const convertResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${legacyId}/convert-to-blocks`,
      TEST_USER_1_TOKEN,
      {}
    );
    expect(convertResponse.status).toBe(200);
    expect(convertResponse.jsonResponse.knowledgeText.contentMode).toBe(
      "blocks"
    );
    expect(convertResponse.jsonResponse.blocks.length).toBe(1);
    expect(convertResponse.jsonResponse.blocks[0].content).toBe(
      "# Legacy page\n\nwith old content"
    );
  });

  test("History endpoint includes block snapshots", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${pageId}/history`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    expect(Array.isArray(response.jsonResponse)).toBe(true);
    expect(response.jsonResponse.length).toBeGreaterThan(0);
    // newest entry snapshotted the pre-update block state
    expect(response.jsonResponse[0].contentMode).toBeDefined();
  });
});
