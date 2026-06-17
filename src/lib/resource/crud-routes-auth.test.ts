/**
 * Tests for the authorization (scope + tenant guard) and OpenAPI wiring added to
 * createCrudRoutes. These run without a database by using tenantGuard: "none"
 * and mocked CRUD operations, so only scope enforcement and route wiring are
 * exercised.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SFContextVariables } from "../../types";
import { createCrudRoutes } from "./crud-routes";
import type { CrudOperations } from "./types";
import { availableScopes, registerScopes } from "../auth/available-scopes";

// Minimal in-memory operations so handlers never touch a database.
const mockOperations: CrudOperations = {
  getAll: async () => [{ id: "1", name: "a" }],
  getById: async (_tenantId, id) => (id === "1" ? { id: "1", name: "a" } : null),
  create: async (_tenantId, data) => ({ id: "new", ...(data as object) }),
  update: async (_tenantId, id, data) =>
    id === "1" ? { id: "1", ...(data as object) } : null,
  remove: async (_tenantId, id) => id === "1",
};

/**
 * Build a Hono app that mounts the CRUD routes and injects a fixed scope list
 * into the context (simulating authAndSetUsersInfo) for each request.
 */
function buildApp(
  config: Parameters<typeof createCrudRoutes>[1],
  scopes: string[]
) {
  const app = new Hono<{ Variables: SFContextVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", scopes);
    await next();
  });
  const { registerRoutes } = createCrudRoutes(mockOperations, config);
  registerRoutes(app);
  return app;
}

describe("registerScopes", () => {
  test("adds new scopes and is idempotent", () => {
    registerScopes("things:read", "things:read", "things:write");
    const readCount = availableScopes.all.filter(
      (s) => s === "things:read"
    ).length;
    expect(readCount).toBe(1);
    expect(availableScopes.all).toContain("things:read");
    expect(availableScopes.all).toContain("things:write");
  });

  test("ignores empty values", () => {
    const before = availableScopes.all.length;
    registerScopes("");
    expect(availableScopes.all.length).toBe(before);
  });
});

describe("createCrudRoutes scope registration", () => {
  test("registers scopePrefix-derived scopes on the available list", () => {
    createCrudRoutes(mockOperations, {
      basePath: "/tenant/:tenantId/widgets",
      entityName: "widget",
      resourceName: "widgets",
      auth: { scopePrefix: "widgets", tenantGuard: "none" },
    });
    expect(availableScopes.all).toContain("widgets:read");
    expect(availableScopes.all).toContain("widgets:write");
  });

  test("registers explicit per-action scopes", () => {
    createCrudRoutes(mockOperations, {
      basePath: "/tenant/:tenantId/gadgets",
      entityName: "gadget",
      auth: {
        tenantGuard: "none",
        read: { scope: "gadgets:view" },
        delete: { scope: "gadgets:purge" },
      },
    });
    expect(availableScopes.all).toContain("gadgets:view");
    expect(availableScopes.all).toContain("gadgets:purge");
  });
});

describe("createCrudRoutes scope enforcement", () => {
  const config = {
    basePath: "/tenant/:tenantId/things",
    entityName: "thing",
    resourceName: "things",
    auth: { scopePrefix: "things", tenantGuard: "none" as const },
  };

  test("allows read with the 'all' scope", async () => {
    const app = buildApp(config, ["all"]);
    const res = await app.request("/tenant/t1/things");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  test("rejects read without the read scope", async () => {
    const app = buildApp(config, []);
    const res = await app.request("/tenant/t1/things");
    expect(res.status).toBe(403);
  });

  test("allows read with the exact read scope", async () => {
    const app = buildApp(config, ["things:read"]);
    const res = await app.request("/tenant/t1/things");
    expect(res.status).toBe(200);
  });

  test("rejects create when only the read scope is present", async () => {
    const app = buildApp(config, ["things:read"]);
    const res = await app.request("/tenant/t1/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("allows create with the write scope", async () => {
    const app = buildApp(config, ["things:write"]);
    const res = await app.request("/tenant/t1/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe("new");
  });

  test("skips scope check entirely when no auth is configured", async () => {
    const app = buildApp(
      {
        basePath: "/tenant/:tenantId/free",
        entityName: "free",
        auth: { tenantGuard: "none" },
      },
      []
    );
    const res = await app.request("/tenant/t1/free");
    expect(res.status).toBe(200);
  });
});
