import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { testFetcher } from "../../../../../test/fetcher.test";
import defineRoutes from ".";
import { initTests, TEST_ORGANISATION_3 } from "../../../../../test/init.test";
import type { SFContextVariables } from "../../../../../types";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../../../../../lib/db/db-connection";

let app = new Hono<{ Variables: SFContextVariables }>();
let TOKEN: string;

// Own tenant so the overview assertion below is not disturbed by fixtures
// other knowledge tests flag as agent instructions.
const TENANT = TEST_ORGANISATION_3.id;
const base = `/api/tenant/${TENANT}/knowledge/texts/agent-instructions`;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineRoutes(app, "/api");
  const { user3Token } = await initTests();
  TOKEN = user3Token;
});

describe("Agent instructions API", () => {
  test("returns null before anything is configured", async () => {
    const res = await testFetcher.get(app, base, TOKEN);
    expect(res.status).toBe(200);
    expect(res.jsonResponse.instructions).toBeNull();
  });

  test("PUT creates the page, a second PUT updates it", async () => {
    const created = await testFetcher.put(app, base, TOKEN, {
      content: "Cite the page title.",
    });
    expect(created.status).toBe(200);
    expect(created.jsonResponse.instructions.content).toBe(
      "Cite the page title."
    );
    const id = created.jsonResponse.instructions.id;

    const updated = await testFetcher.put(app, base, TOKEN, {
      content: "Cite the page title and its id.",
    });
    expect(updated.status).toBe(200);
    expect(updated.jsonResponse.instructions.id).toBe(id);

    const read = await testFetcher.get(app, base, TOKEN);
    expect(read.jsonResponse.instructions.content).toBe(
      "Cite the page title and its id."
    );
  });

  test("the page stays hidden from the normal page endpoints", async () => {
    const saved = await testFetcher.put(app, base, TOKEN, {
      content: "hidden but delivered",
    });
    const id = saved.jsonResponse.instructions.id;

    const list = await testFetcher.get(
      app,
      `/api/tenant/${TENANT}/knowledge/texts`,
      TOKEN
    );
    expect(list.status).toBe(200);
    expect(list.jsonResponse.map((p: { id: string }) => p.id)).not.toContain(
      id
    );

    // ...but the overview an agent loads at session start does carry it
    const overview = await testFetcher.get(
      app,
      `/api/tenant/${TENANT}/knowledge/texts/overview`,
      TOKEN
    );
    expect(overview.status).toBe(200);
    expect(overview.jsonResponse.agentInstructions?.id).toBe(id);
    expect(overview.jsonResponse.agentInstructions?.content).toBe(
      "hidden but delivered"
    );
  });

  test("DELETE removes it and the overview falls back to null", async () => {
    const removed = await testFetcher.delete(app, base, TOKEN);
    expect(removed.status).toBe(200);
    expect(removed.jsonResponse.deleted).toBe(true);

    const read = await testFetcher.get(app, base, TOKEN);
    expect(read.jsonResponse.instructions).toBeNull();

    const overview = await testFetcher.get(
      app,
      `/api/tenant/${TENANT}/knowledge/texts/overview`,
      TOKEN
    );
    expect(overview.jsonResponse.agentInstructions).toBeNull();
  });

  test("rejects an unauthenticated caller", async () => {
    const res = await testFetcher.get(app, base, undefined);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
