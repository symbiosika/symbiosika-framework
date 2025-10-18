import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { definePublicUserRoutes } from "./public";
import { defineSecuredUserRoutes } from "./protected";
import type { FastAppHono } from "../../types";
import { initTests } from "../../test/init.test";
import { TEST_ADMIN_USER } from "../../test/init.test";
import { getDb } from "../../lib/db/db-connection";
import { users } from "../../lib/db/db-schema";
import { eq } from "drizzle-orm";

const TEST_EMAIL_USER = "test-user@symbiosika.de";

describe("User API Endpoints", () => {
  const app: FastAppHono = new Hono();
  let jwt: string;

  beforeAll(async () => {
    const { adminToken } = await initTests();
    jwt = adminToken;

    // Delete any existing test user
    await getDb().delete(users).where(eq(users.email, TEST_EMAIL_USER));

    defineSecuredUserRoutes(app, "/api");
    definePublicUserRoutes(app, "/api");
  });

  // Test user authentication
  it("should login with valid credentials", async () => {
    const loginData = {
      email: TEST_ADMIN_USER.email,
      password: TEST_ADMIN_USER.password,
    };

    const response = await app.request("/api/user/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(loginData),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.token).toBeDefined();
  });

  // Test user profile retrieval
  it("should get user profile", async () => {
    const response = await app.request("/api/user/me", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: `jwt=${jwt}`,
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.email).toBeDefined();
  });

  // Test user profile update
  it("should update user profile", async () => {
    const updateData = {
      firstname: "John",
      surname: "Doe",
      image: "profile.jpg",
    };

    const response = await app.request("/api/user/me", {
      method: "PUT",
      body: JSON.stringify(updateData),
      headers: {
        "Content-Type": "application/json",
        Cookie: `jwt=${jwt}`,
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.firstname).toBe("John");
    expect(data.surname).toBe("Doe");
  });

  // Test user search
  it("should search for user by email", async () => {
    const response = await app.request(
      "/api/user/search?email=" + TEST_ADMIN_USER.email,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Cookie: `jwt=${jwt}`,
        },
      }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.email).toBe(TEST_ADMIN_USER.email);
  });

  // Test user registration
  it("should register new user", async () => {
    const registerData = {
      email: TEST_EMAIL_USER,
      password: TEST_ADMIN_USER.password,
      sendVerificationEmail: false,
    };

    const response = await app.request("/api/user/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(registerData),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBeDefined();
  });

  // Test error cases
  it("should return 401 for invalid login credentials", async () => {
    const invalidLoginResponse = await app.request(
      "/api/user/login?sendVerificationEmail=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: TEST_EMAIL_USER,
          password: "wrongpassword",
        }),
      }
    );
    expect(invalidLoginResponse.status).toBe(401);
  });

  it("should return 400 for search without email parameter", async () => {
    const invalidSearchResponse = await app.request("/api/user/search", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: `jwt=${jwt}`,
      },
    });
    expect(invalidSearchResponse.status).toBe(400);
  });

  it("should return 401 for unauthorized access to /user/me", async () => {
    const unauthorizedResponse = await app.request("/api/user/me", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });
    expect(unauthorizedResponse.status).toBe(401);
  });

  // Test available scopes endpoint
  it("should get available scopes for API tokens", async () => {
    const response = await app.request(
      "/api/user/api-tokens/available-scopes",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Cookie: `jwt=${jwt}`,
        },
      }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("all");
    expect(Array.isArray(data.all)).toBe(true);
    expect(data.all.length).toBeGreaterThan(0);
    expect(data.all).toContain("user:read");
    expect(data.all).toContain("user:write");
  });
});
