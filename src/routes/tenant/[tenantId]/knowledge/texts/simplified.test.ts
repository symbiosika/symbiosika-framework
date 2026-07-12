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
let rootId: string;
let childId: string;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(app, "/api");
  const { user1Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
});

describe("Simplified Knowledge Text API", () => {
  test("Create a parent page with blocks and a sub-page", async () => {
    const rootResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "",
        title: "Simplified API Root",
      }
    );
    expect(rootResponse.status).toBe(200);
    rootId = rootResponse.jsonResponse.id;

    const blocksResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${rootId}/blocks`,
      TEST_USER_1_TOKEN,
      {
        blocks: [
          { type: "markdown", content: "# Root Heading" },
          { type: "html", content: "<p>Root body</p>" },
        ],
      }
    );
    expect(blocksResponse.status).toBe(200);

    const childResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        text: "child page content",
        title: "Simplified API Child",
        parentId: rootId,
      }
    );
    expect(childResponse.status).toBe(200);
    childId = childResponse.jsonResponse.id;
  });

  test("GET simplified returns id, title and merged content only", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${rootId}/simplified`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse).toEqual({
      id: rootId,
      title: "Simplified API Root",
      content: "# Root Heading\n\nRoot body",
    });
  });

  test("GET simplified?recursive=true nests sub-pages under children", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${rootId}/simplified?recursive=true`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.id).toBe(rootId);
    expect(response.jsonResponse.children.length).toBe(1);
    expect(response.jsonResponse.children[0]).toEqual({
      id: childId,
      title: "Simplified API Child",
      content: "child page content",
      children: [],
    });
  });

  test("GET simplified on an unknown page returns 404", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${crypto.randomUUID()}/simplified`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(404);
  });
});
