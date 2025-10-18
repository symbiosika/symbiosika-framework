import { describe, test, expect, beforeAll } from "bun:test";
import {
  initTests,
  TEST_ADMIN_USER,
  TEST_ORGANISATION_1,
} from "../../test/init.test";
import { Hono } from "hono";
import { defineSecuredUserRoutes } from "./protected";
import type { FastAppHono } from "../../types";
import { createApiToken } from "../../lib/auth/token-auth";

describe("Scope Validation Tests", () => {
  let app: FastAppHono;
  let userReadToken: string;
  let orgReadToken: string;

  beforeAll(async () => {
    await initTests();
    app = new Hono();
    defineSecuredUserRoutes(app, "/api");

    // Create API token with user:read scope
    const userReadTokenData = await createApiToken({
      name: "User Read Token",
      userId: TEST_ADMIN_USER.id,
      organisationId: TEST_ORGANISATION_1.id,
      scopes: ["user:read"],
    });
    userReadToken = userReadTokenData.token;

    // Create API token with organisations:read scope
    const orgReadTokenData = await createApiToken({
      name: "Org Read Token",
      userId: TEST_ADMIN_USER.id,
      organisationId: TEST_ORGANISATION_1.id,
      scopes: ["organisations:read"],
    });
    orgReadToken = orgReadTokenData.token;
  });

  test("API token with user:read scope should access /user/me endpoint", async () => {
    const response = await app.request(`/api/user/me?token=${userReadToken}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.email).toBeDefined();
  });

  test("API token with organisations:read scope should not access /user/me endpoint", async () => {
    const response = await app.request(`/api/user/me?token=${orgReadToken}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    expect(response.status).toBe(403);
  });
});
