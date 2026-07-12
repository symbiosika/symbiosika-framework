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
let guideId: string;
let targetId: string;

// unique tag so searches only match this run's fixtures
const RUN_TAG = `agenttest${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(app, "/api");
  const { user1Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
});

describe("Agent API: file-like access, search and links", () => {
  test("Setup: create linked pages", async () => {
    const targetResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        title: `Security Handbook ${RUN_TAG}`,
        text: `All passwords must be rotated every 90 days. ${RUN_TAG}`,
      }
    );
    expect(targetResponse.status).toBe(200);
    targetId = targetResponse.jsonResponse.id;

    const guideResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts`,
      TEST_USER_1_TOKEN,
      {
        tenantId: TEST_ORGANISATION_1.id,
        title: `Onboarding Guide ${RUN_TAG}`,
        text: `line 1 intro\nline 2 details\nline 3 see [[Security Handbook ${RUN_TAG}]]\nline 4 outro ${RUN_TAG}`,
      }
    );
    expect(guideResponse.status).toBe(200);
    guideId = guideResponse.jsonResponse.id;
  });

  test("GET content reads a line range with metadata", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${guideId}/content?fromLine=2&maxLines=2`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.content).toBe(
      `line 2 details\nline 3 see [[Security Handbook ${RUN_TAG}]]`
    );
    expect(response.jsonResponse.fromLine).toBe(2);
    expect(response.jsonResponse.toLine).toBe(3);
    expect(response.jsonResponse.totalLines).toBe(4);
  });

  test("PATCH content performs an exact string replacement", async () => {
    const response = await testFetcher.patch(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${guideId}/content`,
      TEST_USER_1_TOKEN,
      {
        oldString: "line 2 details",
        newString: "line 2 much better details",
      }
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.replacements).toBe(1);
    expect(response.jsonResponse.content).toContain(
      "line 2 much better details"
    );
  });

  test("PATCH content returns 409 for ambiguous or missing strings", async () => {
    const missing = await testFetcher.patch(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${guideId}/content`,
      TEST_USER_1_TOKEN,
      { oldString: "does not exist anywhere", newString: "x" }
    );
    expect(missing.status).toBe(409);

    const ambiguous = await testFetcher.patch(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${guideId}/content`,
      TEST_USER_1_TOKEN,
      { oldString: "line", newString: "row" }
    );
    expect(ambiguous.status).toBe(409);
  });

  test("GET search finds pages via full-text", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/search?q=${encodeURIComponent(
        `passwords ${RUN_TAG}`
      )}&mode=fulltext`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.length).toBeGreaterThan(0);
    expect(response.jsonResponse[0].title).toBe(
      `Security Handbook ${RUN_TAG}`
    );
    expect(response.jsonResponse[0].snippet.toLowerCase()).toContain(
      "passwords"
    );
    expect(response.jsonResponse[0].matchedBy).toEqual(["fulltext"]);
  });

  test("GET search requires a query", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/search`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(400);
  });

  test("GET links returns the resolved wikilink", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${guideId}/links`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.length).toBe(1);
    expect(response.jsonResponse[0].resolved).toBe(true);
    expect(response.jsonResponse[0].page.id).toBe(targetId);
  });

  test("GET backlinks returns the linking page", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${targetId}/backlinks`,
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.length).toBe(1);
    expect(response.jsonResponse[0].page.id).toBe(guideId);
    expect(response.jsonResponse[0].page.title).toBe(
      `Onboarding Guide ${RUN_TAG}`
    );
  });

  test("GET related returns [] for pages without embeddings", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${guideId}/related`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    expect(response.jsonResponse).toEqual([]);
  });

  test("GET content on an unknown page returns 404", async () => {
    const response = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/knowledge/texts/${crypto.randomUUID()}/content`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(404);
  });
});
