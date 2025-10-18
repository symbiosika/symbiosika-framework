import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import definePingRoute from ".";
import type { FastAppHono } from "../../types";

describe("Ping API Endpoint", () => {
  const app: FastAppHono = new Hono();

  beforeAll(() => {
    definePingRoute(app, "/api");
  });

  it("should return online status and internet connectivity", async () => {
    const response = await app.request("/api/ping");
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveProperty("online", true);
    expect(data).toHaveProperty("canConnectToInternet");
    expect(typeof data.canConnectToInternet).toBe("boolean");
  });
});
