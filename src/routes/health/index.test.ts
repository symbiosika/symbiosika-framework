import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import defineHealthRoute from ".";
import type { SymbiosikaFrameworkHonoApp } from "../../types";

describe("Health API Endpoints", () => {
  const app: SymbiosikaFrameworkHonoApp = new Hono();

  beforeAll(() => {
    defineHealthRoute(app);
  });

  it("GET /health should return ok without auth", async () => {
    const response = await app.request("/health");
    const data: any = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveProperty("status", "ok");
  });

  it("GET /health/detail should require authentication", async () => {
    const response = await app.request("/health/detail");
    expect(response.status).toBe(401);
  });
});
