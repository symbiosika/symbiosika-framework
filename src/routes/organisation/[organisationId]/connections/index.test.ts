/**
 * Connections Routes Tests
 * Tests for server-to-server connection API endpoints
 */

import { describe, test, expect, beforeAll } from "bun:test";
import type { FastAppHono } from "../../../../types";
import { initTests, TEST_ORGANISATION_1 } from "../../../../test/init.test";
import { testFetcher } from "../../../../test/fetcher.test";
import { getDb } from "../../../../lib/db/db-connection";
import { connections, connectionSessions } from "../../../../lib/db/db-schema";
import { eq } from "drizzle-orm";
import { generateKeyPair } from "../../../../lib/connections";
import defineConnectionsRoutes from "./index";
import { Hono } from "hono";

// Test data
const TEST_ORG_ID = TEST_ORGANISATION_1.id;
const TEST_REMOTE_ORG_ID = "00000000-0000-0000-0000-000000000002";
const TEST_REMOTE_URL = "https://localhost/api/v1";
const TEST_CONNECTION_NAME = "Test Connection";
const BASEPATH = "/api";

let app: FastAppHono;
let adminToken: string;

beforeAll(async () => {
  const { user1Token } = await initTests();
  adminToken = user1Token;

  app = new Hono() as any;
  defineConnectionsRoutes(app, BASEPATH);

  // Clean up test data
  const db = getDb();
  await db
    .delete(connections)
    .where(eq(connections.organisationId, TEST_ORG_ID));
  await db
    .delete(connections)
    .where(eq(connections.remoteOrganisationId, TEST_ORG_ID));
});

describe("Connections API Routes", () => {
  /**
   * POST /validate-credentials
   */
  describe("POST /validate-credentials", () => {
    test("should validate remote credentials successfully", async () => {
      // Mock fetch for remote server
      const originalFetch = global.fetch;
      (global as any).fetch = async (url: string) => {
        if (url.includes("/user/login")) {
          return {
            ok: true,
            json: async () => ({ token: "test-token" }),
          } as Response;
        } else if (url.includes("/user/organisations")) {
          return {
            ok: true,
            json: async () => ({
              organisations: [{ id: TEST_REMOTE_ORG_ID, name: "Remote Org" }],
            }),
          } as Response;
        }
        return { ok: false } as Response;
      };

      try {
        const response = await testFetcher.post(
          app,
          `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/validate-credentials`,
          adminToken,
          {
            remoteUrl: TEST_REMOTE_URL,
            email: "admin@remote.com",
            password: "password123",
          }
        );

        expect(response.status).toBe(200);
        expect(response.jsonResponse.organisations).toBeDefined();
        expect(Array.isArray(response.jsonResponse.organisations)).toBe(true);
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    test("should return 400 for invalid credentials", async () => {
      const originalFetch = global.fetch;
      (global as any).fetch = async () => {
        return { ok: false, statusText: "Unauthorized" } as Response;
      };

      try {
        const response = await testFetcher.post(
          app,
          `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/validate-credentials`,
          adminToken,
          {
            remoteUrl: TEST_REMOTE_URL,
            email: "wrong@remote.com",
            password: "wrong",
          }
        );

        expect(response.status).toBe(400);
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    test("should return 400 for missing required fields", async () => {
      const response = await testFetcher.post(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/validate-credentials`,
        adminToken,
        {
          remoteUrl: TEST_REMOTE_URL,
          // missing email and password
        }
      );

      expect(response.status).toBe(400);
    });
  });

  /**
   * POST /init
   */
  describe("POST /init", () => {
    test("should initialize new connection", async () => {
      const originalFetch = global.fetch;
      (global as any).fetch = async (url: string) => {
        if (url.includes("/user/login")) {
          return {
            ok: true,
            json: async () => ({ token: "test-token" }),
          } as Response;
        } else if (url.includes("/user/organisations")) {
          return {
            ok: true,
            json: async () => ({
              organisations: [{ id: TEST_REMOTE_ORG_ID, name: "Remote Org" }],
            }),
          } as Response;
        } else if (url.includes("/exchange-keys")) {
          return {
            ok: true,
            json: async () => ({
              remotePublicKey:
                "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
            }),
          } as Response;
        }
        return { ok: false } as Response;
      };

      try {
        const response = await testFetcher.post(
          app,
          `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/init`,
          adminToken,
          {
            remoteUrl: TEST_REMOTE_URL,
            remoteEmail: "admin@remote.com",
            remotePassword: "password123",
            remoteOrganisationId: TEST_REMOTE_ORG_ID,
            name: TEST_CONNECTION_NAME,
          }
        );

        expect(response.status).toBe(201);
        expect(response.jsonResponse.connectionId).toBeDefined();
        expect(response.jsonResponse.status).toBe("active");
        expect(response.jsonResponse.localPublicKey).toBeDefined();
        expect(response.jsonResponse.remotePublicKey).toBeDefined();
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    test("should return 400 for invalid remote organisation", async () => {
      const originalFetch = global.fetch;
      (global as any).fetch = async (url: string) => {
        if (url.includes("/user/login")) {
          return {
            ok: true,
            json: async () => ({ token: "test-token" }),
          } as Response;
        } else if (url.includes("/user/organisations")) {
          return {
            ok: true,
            json: async () => ({ organisations: [] }),
          } as Response;
        }
        return { ok: false } as Response;
      };

      try {
        const response = await testFetcher.post(
          app,
          `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/init`,
          adminToken,
          {
            remoteUrl: TEST_REMOTE_URL,
            remoteEmail: "admin@remote.com",
            remotePassword: "password123",
            remoteOrganisationId: "invalid-org",
            name: TEST_CONNECTION_NAME,
          }
        );

        expect(response.status).toBe(400);
      } finally {
        (global as any).fetch = originalFetch;
      }
    });

    test("should return 400 for missing required fields", async () => {
      const response = await testFetcher.post(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/init`,
        adminToken,
        {
          remoteUrl: TEST_REMOTE_URL,
          // missing other fields
        }
      );

      expect(response.status).toBe(400);
    });
  });

  /**
   * GET /
   */
  describe("GET /", () => {
    test("should list all connections for organisation", async () => {
      const response = await testFetcher.get(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections`,
        adminToken
      );

      expect(response.status).toBe(200);
      expect(response.jsonResponse.connections).toBeDefined();
      expect(Array.isArray(response.jsonResponse.connections)).toBe(true);
    });

    test("should return 401 without authentication", async () => {
      const response = await testFetcher.get(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections`,
        "invalid-token"
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  /**
   * GET /:connectionId
   */
  describe("GET /:connectionId", () => {
    test("should retrieve specific connection", async () => {
      const db = getDb();

      // Create a test connection
      const { publicKey, privateKey } = generateKeyPair();
      const connResult = await db
        .insert(connections)
        .values({
          organisationId: TEST_ORG_ID,
          name: "Get Test Connection",
          localPublicKey: publicKey,
          localPrivateKey: privateKey,
        })
        .returning();

      const connectionId = connResult[0]?.id;
      expect(connectionId).toBeDefined();

      const response = await testFetcher.get(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/${connectionId}`,
        adminToken
      );

      expect(response.status).toBe(200);
      expect(response.jsonResponse.id).toBe(connectionId);
      expect(response.jsonResponse.name).toBe("Get Test Connection");
    });

    test("should return 404 for non-existent connection", async () => {
      const response = await testFetcher.get(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/00000000-0000-0000-0000-000000000999`,
        adminToken
      );

      expect(response.status).toBe(404);
    });
  });

  /**
   * GET /:connectionId/sessions
   */
  describe("GET /:connectionId/sessions", () => {
    test("should list sessions for connection", async () => {
      const db = getDb();

      // Create a test connection
      const { publicKey, privateKey } = generateKeyPair();
      const connResult = await db
        .insert(connections)
        .values({
          organisationId: TEST_ORG_ID,
          name: "Sessions Test",
          localPublicKey: publicKey,
          localPrivateKey: privateKey,
        })
        .returning();

      const connectionId = connResult[0]?.id;
      expect(connectionId).toBeDefined();

      // Create test session
      await db.insert(connectionSessions).values({
        connectionId: connectionId!,
        status: "active",
      });

      const response = await testFetcher.get(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/${connectionId}/sessions`,
        adminToken
      );

      expect(response.status).toBe(200);
      expect(response.jsonResponse.sessions).toBeDefined();
      expect(Array.isArray(response.jsonResponse.sessions)).toBe(true);
    });
  });

  /**
   * DELETE /:connectionId/sessions/:sessionId
   */
  describe("DELETE /:connectionId/sessions/:sessionId", () => {
    test("should drop connection session", async () => {
      const db = getDb();

      // Create connection and session
      const { publicKey, privateKey } = generateKeyPair();
      const connResult = await db
        .insert(connections)
        .values({
          organisationId: TEST_ORG_ID,
          name: "Drop Session Test",
          localPublicKey: publicKey,
          localPrivateKey: privateKey,
        })
        .returning();

      const connectionId = connResult[0]?.id;
      expect(connectionId).toBeDefined();

      const sessionResult = await db
        .insert(connectionSessions)
        .values({
          connectionId: connectionId + "",
          status: "active",
        })
        .returning();

      const sessionId = sessionResult[0]?.id;
      expect(sessionId).toBeDefined();

      const response = await testFetcher.delete(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/${connectionId}/sessions/${sessionId}`,
        adminToken
      );

      expect(response.status).toBe(200);
      expect(response.jsonResponse.message).toContain("dropped");

      // Verify deleted
      const deleted = await db
        .select()
        .from(connectionSessions)
        .where(eq(connectionSessions.id, sessionId!));

      expect(deleted).toHaveLength(0);
    });
  });

  /**
   * DELETE /:connectionId
   */
  describe("DELETE /:connectionId", () => {
    test("should drop connection and all sessions", async () => {
      const db = getDb();

      // Create connection
      const { publicKey, privateKey } = generateKeyPair();
      const connResult = await db
        .insert(connections)
        .values({
          organisationId: TEST_ORG_ID,
          name: "Drop Connection Test",
          localPublicKey: publicKey,
          localPrivateKey: privateKey,
        })
        .returning();

      const connectionId = connResult[0]?.id;
      expect(connectionId).toBeDefined();

      // Create sessions
      await db.insert(connectionSessions).values({
        connectionId: connectionId!,
        status: "active",
      });

      const response = await testFetcher.delete(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/${connectionId}`,
        adminToken
      );

      expect(response.status).toBe(200);
      expect(response.jsonResponse.message).toContain("dropped");

      // Verify connection deleted
      const connDeleted = await db
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId!));

      expect(connDeleted).toHaveLength(0);

      // Verify sessions deleted (cascade)
      const sessionsDeleted = await db
        .select()
        .from(connectionSessions)
        .where(eq(connectionSessions.connectionId, connectionId!));

      expect(sessionsDeleted).toHaveLength(0);
    });
  });

  /**
   * POST /exchange-keys
   */
  describe("POST /exchange-keys", () => {
    test("should exchange public keys", async () => {
      const db = getDb();

      // Create connection
      const { publicKey, privateKey } = generateKeyPair();
      const connResult = await db
        .insert(connections)
        .values({
          organisationId: TEST_ORG_ID,
          name: "Exchange Keys Test",
          localPublicKey: publicKey,
          localPrivateKey: privateKey,
        })
        .returning();

      const connectionId = connResult[0]?.id;
      expect(connectionId).toBeDefined();

      const response = await testFetcher.post(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/exchange-keys`,
        adminToken,
        {
          publicKey:
            "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
          connectionId: connectionId,
        }
      );

      expect(response.status).toBe(200);
      expect(response.jsonResponse.remotePublicKey).toBeDefined();
      expect(response.jsonResponse.remoteConnectionId).toBeDefined();
    });

    test("should return 400 for missing required fields", async () => {
      const response = await testFetcher.post(
        app,
        `${BASEPATH}/organisation/${TEST_ORG_ID}/connections/exchange-keys`,
        adminToken,
        {
          // missing fields
        }
      );

      expect(response.status).toBe(400);
    });
  });
});
