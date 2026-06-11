/**
 * Integration tests for the resource system against a real framework table.
 *
 * Uses `tenantSpecificData` (a real, tenant-scoped table) wired through
 * `defineResource`, and exercises the generated HTTP API end-to-end against a
 * live Postgres: CRUD, URL filtering, sorting, pagination, relation expansion
 * (?expand=) and tenant isolation.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORGANISATION_2,
} from "../../test/init.test";
import { testFetcher } from "../../test/fetcher.test";
import { getDb } from "../db/db-connection";
import {
  tenantSpecificData,
  tenantSpecificDataInsertSchema,
  tenantSpecificDataUpdateSchema,
} from "../db/schema/additional-data";
import type { SymbiosikaFrameworkHonoApp } from "../../types";
import { defineResource } from "./define-resource";

// A resource built from a real framework table.
const resource = defineResource({
  table: tenantSpecificData,
  name: "tenant-specific-data",
  route: "/tenant/:tenantId/tenant-specific-data",
  insertSchema: tenantSpecificDataInsertSchema,
  updateSchema: tenantSpecificDataUpdateSchema,
  defaultOrderBy: (t) => [t.key],
  relations: {
    queryKey: "tenantSpecificData",
    allowed: ["tenant"],
  },
});

let app: SymbiosikaFrameworkHonoApp;
const ORG1 = TEST_ORGANISATION_1.id;
const ORG2 = TEST_ORGANISATION_2.id;
const base1 = `/tenant/${ORG1}/tenant-specific-data`;
const base2 = `/tenant/${ORG2}/tenant-specific-data`;

const cleanup = () =>
  getDb()
    .delete(tenantSpecificData)
    .where(inArray(tenantSpecificData.tenantId, [ORG1, ORG2]));

describe("Resource system (defineResource) against tenantSpecificData", () => {
  beforeAll(async () => {
    await initTests();
    app = new Hono();
    resource.registerRoutes(app);
    await cleanup();

    // Seed a known data set in ORG1 (and one row in ORG2 for isolation checks).
    const seed = [
      { tenantId: ORG1, key: "alpha", version: 1, data: { kind: "fruit" } },
      { tenantId: ORG1, key: "beta", version: 2, data: { kind: "fruit" } },
      { tenantId: ORG1, key: "gamma", version: 3, data: { kind: "veg" } },
      { tenantId: ORG2, key: "alpha", version: 9, data: { kind: "other" } },
    ];
    await getDb().insert(tenantSpecificData).values(seed);
  });

  afterAll(() => {
    cleanup().then(() => {});
  });

  test("CRUD cycle via the generated routes", async () => {
    const created = await testFetcher.post(app, base1, undefined, {
      key: "crud-item",
      version: 0,
      data: { hello: "world" },
    });
    expect(created.status).toBe(200);
    expect(created.jsonResponse?.success).toBe(true);
    const id = created.jsonResponse?.data.id;
    expect(id).toBeDefined();
    expect(created.jsonResponse?.data.tenantId).toBe(ORG1);

    const fetched = await testFetcher.get(app, `${base1}/${id}`, undefined);
    expect(fetched.status).toBe(200);
    expect(fetched.jsonResponse?.data.key).toBe("crud-item");

    const updated = await testFetcher.put(app, `${base1}/${id}`, undefined, {
      data: { hello: "updated" },
    });
    expect(updated.status).toBe(200);
    expect(updated.jsonResponse?.data.data).toEqual({ hello: "updated" });

    const removed = await testFetcher.delete(app, `${base1}/${id}`, undefined);
    expect(removed.status).toBe(200);

    const gone = await testFetcher.get(app, `${base1}/${id}`, undefined);
    expect(gone.status).toBe(404);
  });

  test("filter: eq on a text column", async () => {
    const res = await testFetcher.get(app, `${base1}?key=eq.beta`, undefined);
    expect(res.status).toBe(200);
    expect(res.jsonResponse.data).toHaveLength(1);
    expect(res.jsonResponse.data[0].key).toBe("beta");
  });

  test("filter: like (case-insensitive contains)", async () => {
    const res = await testFetcher.get(app, `${base1}?key=like.ET`, undefined);
    expect(res.status).toBe(200);
    const keys = res.jsonResponse.data.map((r: any) => r.key);
    expect(keys).toEqual(["beta"]);
  });

  test("filter: in (list membership)", async () => {
    const res = await testFetcher.get(
      app,
      `${base1}?key=in.(alpha,gamma)`,
      undefined
    );
    expect(res.status).toBe(200);
    const keys = res.jsonResponse.data.map((r: any) => r.key).sort();
    expect(keys).toEqual(["alpha", "gamma"]);
  });

  test("filter: gte / lte on a numeric column", async () => {
    const gte = await testFetcher.get(app, `${base1}?version=gte.2`, undefined);
    expect(gte.status).toBe(200);
    expect(gte.jsonResponse.data.map((r: any) => r.version).sort()).toEqual([
      2, 3,
    ]);

    const lte = await testFetcher.get(app, `${base1}?version=lte.2`, undefined);
    expect(lte.status).toBe(200);
    expect(lte.jsonResponse.data.map((r: any) => r.version).sort()).toEqual([
      1, 2,
    ]);
  });

  test("sorting and pagination", async () => {
    const desc = await testFetcher.get(
      app,
      `${base1}?orderBy=key&orderDirection=desc`,
      undefined
    );
    expect(desc.jsonResponse.data.map((r: any) => r.key)).toEqual([
      "gamma",
      "beta",
      "alpha",
    ]);

    const paged = await testFetcher.get(
      app,
      `${base1}?orderBy=key&orderDirection=asc&limit=1&offset=1`,
      undefined
    );
    expect(paged.jsonResponse.data).toHaveLength(1);
    expect(paged.jsonResponse.data[0].key).toBe("beta");
  });

  test("expand: eager-load the tenant relation", async () => {
    const res = await testFetcher.get(
      app,
      `${base1}?key=eq.alpha&expand=tenant`,
      undefined
    );
    expect(res.status).toBe(200);
    expect(res.jsonResponse.data).toHaveLength(1);
    expect(res.jsonResponse.data[0].tenant).toBeDefined();
    expect(res.jsonResponse.data[0].tenant.id).toBe(ORG1);
    expect(res.jsonResponse.data[0].tenant.name).toBe(TEST_ORGANISATION_1.name);
  });

  test("expand: non-allowlisted relations are ignored", async () => {
    const res = await testFetcher.get(
      app,
      `${base1}?key=eq.alpha&expand=secretRelation`,
      undefined
    );
    expect(res.status).toBe(200);
    expect(res.jsonResponse.data[0].secretRelation).toBeUndefined();
  });

  test("filter on an unknown column is ignored (no injection)", async () => {
    const res = await testFetcher.get(
      app,
      `${base1}?notAColumn=eq.whatever`,
      undefined
    );
    expect(res.status).toBe(200);
    // All ORG1 rows returned, the bogus filter had no effect
    expect(res.jsonResponse.data.length).toBe(3);
  });

  test("tenant isolation: list is scoped to the URL tenant", async () => {
    const res1 = await testFetcher.get(app, base1, undefined);
    const res2 = await testFetcher.get(app, base2, undefined);
    expect(res1.jsonResponse.data.length).toBe(3);
    expect(res2.jsonResponse.data.length).toBe(1);
    expect(res2.jsonResponse.data[0].version).toBe(9);
  });

  test("tenant isolation: getById cannot cross tenants", async () => {
    const org2List = await testFetcher.get(app, base2, undefined);
    const org2Id = org2List.jsonResponse.data[0].id;

    // The ORG2 row must not be reachable through the ORG1 scope
    const cross = await testFetcher.get(app, `${base1}/${org2Id}`, undefined);
    expect(cross.status).toBe(404);
  });
});
