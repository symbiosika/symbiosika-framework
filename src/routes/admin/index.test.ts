import { describe, it, expect, beforeAll } from "bun:test";
import { testFetcher } from "../../test/fetcher.test";
import { Hono } from "hono";
import type { FastAppHono } from "../../types";
import { initTests } from "../../test/init.test";
import defineAdminRoutes from "./index";

let TEST_ADMIN_TOKEN: string;

// Initialize the app and define routes
const app: FastAppHono = new Hono();
defineAdminRoutes(app, "/api");

// Test suite for admin endpoints
describe("Admin API Endpoints", () => {
  beforeAll(async () => {
    const { adminToken } = await initTests();
    TEST_ADMIN_TOKEN = adminToken;
  });

  it("should download logs successfully", async () => {
    const response = await testFetcher.get(
      app,
      "/api/admin/logs/download",
      TEST_ADMIN_TOKEN
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/gzip");
  });

  it("should clear logs successfully", async () => {
    const response = await testFetcher.post(
      app,
      "/api/admin/logs/clear",
      TEST_ADMIN_TOKEN,
      {}
    );
    expect(response.status).toBe(200);
  });
});
