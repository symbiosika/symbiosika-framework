import { describe, test, expect, beforeAll } from "bun:test";
import { testFetcher } from "../../../../../test/fetcher.test";
import defineRoutes from ".";
import { initTests, TEST_ORGANISATION_1 } from "../../../../../test/init.test";
import { Hono } from "hono";
import type { SFContextVariables } from "../../../../../types";
import { eq } from "drizzle-orm";
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../../../../../lib/db/db-connection";
import { knowledgeTextBlock } from "../../../../../lib/db/schema/knowledge";
import { MAX_KEY_LENGTH_BEFORE_REBALANCE } from "../../../../../lib/utils/fractional-index";

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

  /**
   * The ordering keys grow by ~1 character per 4 appended blocks. While the
   * column was varchar(64) that made a page of ~257 blocks permanently
   * unsaveable: the INSERT was rejected and the route answered 400 on every
   * further save. The column is `text` now and long keys are compacted on save.
   */
  test("PUT blocks saves a page far beyond the old 256-block ceiling", async () => {
    const createResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "",
        title: "Blocks API Large Page",
      }
    );
    expect(createResponse.status).toBe(200);
    const largePageId = createResponse.jsonResponse.id;

    const blocks = Array.from({ length: 300 }, (_, i) => ({
      type: "markdown" as const,
      content: `Absatz ${i}`,
    }));
    const response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${largePageId}/blocks`,
      TEST_USER_1_TOKEN,
      { blocks }
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.blocks.length).toBe(300);
    expect(response.jsonResponse.changes.inserted).toBe(300);
    // order survived, and the keys stayed compact
    expect(response.jsonResponse.blocks[0].content).toBe("Absatz 0");
    expect(response.jsonResponse.blocks[299].content).toBe("Absatz 299");
    const longest = Math.max(
      ...response.jsonResponse.blocks.map((b: { position: string }) => b.position.length)
    );
    expect(longest).toBeLessThanOrEqual(MAX_KEY_LENGTH_BEFORE_REBALANCE);
  });

  /**
   * A page that already carries long keys (saved before the fix) must re-key
   * itself on the next save. That rewrites every row at once — which only works
   * because the update goes through temporary keys; applied directly, the rows
   * would collide on the unique (page, position) index.
   */
  test("PUT blocks re-keys a page whose stored keys are over-long", async () => {
    const createResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "",
        title: "Blocks API Long Keys Page",
      }
    );
    const longKeyPageId = createResponse.jsonResponse.id;

    const initial = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${longKeyPageId}/blocks`,
      TEST_USER_1_TOKEN,
      {
        blocks: [
          { type: "markdown" as const, content: "erster" },
          { type: "markdown" as const, content: "zweiter" },
          { type: "markdown" as const, content: "dritter" },
        ],
      }
    );
    expect(initial.status).toBe(200);
    const ids = initial.jsonResponse.blocks.map((b: { id: string }) => b.id);

    // simulate the pre-fix state: keys grown past the rebalance threshold
    for (let i = 0; i < ids.length; i++) {
      await getDb()
        .update(knowledgeTextBlock)
        .set({ position: "z".repeat(40) + String.fromCharCode(98 + i) })
        .where(eq(knowledgeTextBlock.id, ids[i]!));
    }

    // a normal save: same blocks, one edited
    const response = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${longKeyPageId}/blocks`,
      TEST_USER_1_TOKEN,
      {
        blocks: [
          { id: ids[0], type: "markdown" as const, content: "erster" },
          { id: ids[1], type: "markdown" as const, content: "zweiter, editiert" },
          { id: ids[2], type: "markdown" as const, content: "dritter" },
        ],
      }
    );

    expect(response.status).toBe(200);
    // same blocks in the same order, now on compact keys
    expect(response.jsonResponse.blocks.map((b: { id: string }) => b.id)).toEqual(ids);
    expect(response.jsonResponse.blocks[1].content).toBe("zweiter, editiert");
    for (const block of response.jsonResponse.blocks as { position: string }[]) {
      expect(block.position.length).toBeLessThanOrEqual(
        MAX_KEY_LENGTH_BEFORE_REBALANCE
      );
      expect(/^[a-z]+$/.test(block.position)).toBe(true);
    }
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
