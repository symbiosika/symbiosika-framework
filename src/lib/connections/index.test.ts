/**
 * Connections Service Tests
 * Tests for server-to-server connection business logic
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { connections, connectionSessions } from "../db/db-schema";
import { eq } from "drizzle-orm";
import {
  connectionsService,
  generateKeyPair,
  validateRemoteCredentials,
  initializeConnection,
  createConnectionSession,
  getConnection,
  getConnectionByOrganisations,
  listConnections,
  listConnectionSessions,
  updateSessionHeartbeat,
  dropConnectionSession,
  dropConnection,
} from "./index";

const TEST_ORG_ID = TEST_ORGANISATION_1.id;
const TEST_REMOTE_ORG_ID = "00000000-0000-0000-0000-000000000001";
const TEST_REMOTE_URL = "https://localhost/api/v1";
const TEST_CONNECTION_NAME = "Test Connection";

beforeAll(async () => {
  await initTests();
  // delete all old connections 
  await getDb().delete(connections).where(eq(connections.organisationId, TEST_ORG_ID));
  await getDb().delete(connections).where(eq(connections.remoteOrganisationId, TEST_ORG_ID));
  await getDb().delete(connectionSessions).where(eq(connectionSessions.connectionId, TEST_ORG_ID));
});

describe("Connections Service", () => {
  /**
   * Test: generateKeyPair
   */
  test("generateKeyPair should generate valid RSA key pair", () => {
    const keyPair = generateKeyPair();

    expect(keyPair).toBeDefined();
    expect(keyPair.publicKey).toBeDefined();
    expect(keyPair.privateKey).toBeDefined();
    expect(keyPair.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(keyPair.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  test("generateKeyPair should generate different keys on each call", () => {
    const keyPair1 = generateKeyPair();
    const keyPair2 = generateKeyPair();

    expect(keyPair1.publicKey).not.toBe(keyPair2.publicKey);
    expect(keyPair1.privateKey).not.toBe(keyPair2.privateKey);
  });

  /**
   * Test: validateRemoteCredentials
   */
  test("validateRemoteCredentials should fetch and return organisations", async () => {
    const mockOrgData = {
      organisations: [{ id: TEST_REMOTE_ORG_ID, name: "Remote Organisation" }],
    };

    // Mock fetch for login endpoint
    const originalFetch = global.fetch;
    (global as any).fetch = async (url: string, _options?: RequestInit) => {
      if (url.includes("/user/login")) {
        return {
          ok: true,
          json: async () => ({ token: "test-token" }),
        } as Response;
      } else if (url.includes("/user/organisations")) {
        return {
          ok: true,
          json: async () => mockOrgData,
        } as Response;
      }
      return { ok: false } as Response;
    };

    try {
      const result = await validateRemoteCredentials(
        TEST_REMOTE_URL,
        "test@example.com",
        "password123"
      );

      expect(result.token).toBe("test-token");
      expect(result.organisations).toHaveLength(1);
      expect((result.organisations[0] as any)?.id).toBe(TEST_REMOTE_ORG_ID);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  test("validateRemoteCredentials should throw on invalid credentials", async () => {
    const originalFetch = global.fetch;
    (global as any).fetch = async () => {
      return { ok: false, statusText: "Unauthorized" } as Response;
    };

    try {
      let threw = false;
      try {
        await validateRemoteCredentials(TEST_REMOTE_URL, "wrong@example.com", "wrong");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  test("validateRemoteCredentials should throw when no token received", async () => {
    const originalFetch = global.fetch;
    (global as any).fetch = async () => {
      return { ok: true, json: async () => ({}) } as Response;
    };

    try {
      let threw = false;
      try {
        await validateRemoteCredentials(TEST_REMOTE_URL, "test@example.com", "password");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  /**
   * Test: initializeConnection
   */
  test("initializeConnection should create new connection", async () => {
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
      const result = await initializeConnection(
        TEST_ORG_ID,
        TEST_REMOTE_URL,
        "admin@remote.com",
        "password123",
        TEST_REMOTE_ORG_ID,
        TEST_CONNECTION_NAME
      );

      expect(result).toBeDefined();
      expect(result.connectionId).toBeDefined();
      expect(result.status).toBe("active");
      expect(result.localPublicKey).toContain("BEGIN PUBLIC KEY");
      expect(result.remotePublicKey).toBeDefined();

      // Verify in database
      const conn = await getConnection(result.connectionId);
      expect(conn).toBeDefined();
      expect(conn?.name).toBe(TEST_CONNECTION_NAME);
      expect(conn?.organisationId).toBe(TEST_ORG_ID as any);
      expect(conn?.remoteOrganisationId).toBe(TEST_REMOTE_ORG_ID as any);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  test("initializeConnection should re-initialize existing connection", async () => {
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
      // Create first connection
      const result1 = await initializeConnection(
        TEST_ORG_ID,
        TEST_REMOTE_URL,
        "admin@remote.com",
        "password123",
        TEST_REMOTE_ORG_ID,
        "Original Name"
      );

      const originalId = result1.connectionId;

      // Initialize again with same orgs
      const result2 = await initializeConnection(
        TEST_ORG_ID,
        TEST_REMOTE_URL,
        "admin@remote.com",
        "password123",
        TEST_REMOTE_ORG_ID,
        "Updated Name"
      );

      // Should return same connection ID
      expect(result2.connectionId).toBe(originalId);

      // Verify updated name
      const conn = await getConnection(result2.connectionId);
      expect(conn?.name).toBe("Updated Name");
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  test("initializeConnection should throw on invalid remote organisation", async () => {
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
      let threw = false;
      try {
        await initializeConnection(
          TEST_ORG_ID,
          TEST_REMOTE_URL,
          "admin@remote.com",
          "password123",
          "invalid-org-id",
          TEST_CONNECTION_NAME
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  /**
   * Test: createConnectionSession
   */
  test("createConnectionSession should create new session", async () => {
    const db = getDb();

    // First create a connection
    const keyPair = generateKeyPair();
    const connResult = await db
      .insert(connections)
      .values({
        organisationId: TEST_ORG_ID as any,
        name: "Test Connection",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    const connectionId = connResult[0]?.id;
    expect(connectionId).toBeDefined();

    // Create session
    const session = await createConnectionSession(connectionId!);

    expect(session).toBeDefined();
    expect(session.id).toBeDefined();
    expect(session.connectionId).toBe(connectionId as any);
    expect(session.status).toBe("active");

    // Verify in database
    const dbSession = await db
      .select()
      .from(connectionSessions)
      .where(eq(connectionSessions.id, session.id as any));

    expect(dbSession).toHaveLength(1);
  });

  test("createConnectionSession should store remote session ID", async () => {
    const db = getDb();

    // Create connection
    const keyPair = generateKeyPair();
    const connResult = await db
      .insert(connections)
      .values({
        organisationId: TEST_ORG_ID as any,
        name: "Test Connection 2",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    const connectionId = connResult[0]?.id;
    expect(connectionId).toBeDefined();

    const remoteSessionId = crypto.randomUUID();

    // Create session with remote session ID
    const session = await createConnectionSession(connectionId!, remoteSessionId);

    expect(session.remoteSessionId).toBe(remoteSessionId as any);
  });

  /**
   * Test: getConnection
   */
  test("getConnection should retrieve connection by ID", async () => {
    const db = getDb();

    // Create connection
    const keyPair = generateKeyPair();
    const connResult = await db
      .insert(connections)
      .values({
        organisationId: TEST_ORG_ID as any,
        name: "Get Test Connection",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    const connectionId = connResult[0]?.id;
    expect(connectionId).toBeDefined();

    // Retrieve it
    const conn = await getConnection(connectionId!);

    expect(conn).toBeDefined();
    expect(conn?.id).toBe(connectionId);
    expect(conn?.name).toBe("Get Test Connection");
  });

  test("getConnection should return null for non-existent connection", async () => {
    const conn = await getConnection(
      "00000000-0000-0000-0000-000000000999"
    );

    expect(conn).toBeNull();
  });

  /**
   * Test: getConnectionByOrganisations
   */
  test("getConnectionByOrganisations should retrieve connection", async () => {
    const db = getDb();

    // Create connection
    const keyPair = generateKeyPair();
    const connResult = await db
      .insert(connections)
      .values({
        organisationId: TEST_ORG_ID,
        remoteOrganisationId: TEST_ORG_ID,
        name: "Org Connection",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    // Retrieve by organisations
    const conn = await getConnectionByOrganisations(
      TEST_ORG_ID,
      TEST_ORG_ID
    );

    expect(conn).toBeDefined();
    expect(conn?.id).toBe(connResult[0]?.id);
  });

  test("getConnectionByOrganisations should return null for non-existent combination", async () => {
    const conn = await getConnectionByOrganisations(
      "00000000-0000-0000-0000-000000000888",
      "00000000-0000-0000-0000-000000000999"
    );

    expect(conn).toBeNull();
  });

  /**
   * Test: listConnections
   */
  test("listConnections should return all connections for organisation", async () => {
    const db = getDb();
    const testOrgId = TEST_ORG_ID;

    // Create multiple connections
    const keyPair1 = generateKeyPair();
    const keyPair2 = generateKeyPair();

    await db.insert(connections).values([
      {
        organisationId: testOrgId as any,
        name: "Connection 1",
        localPublicKey: keyPair1.publicKey,
        localPrivateKey: keyPair1.privateKey,
      },
      {
        organisationId: testOrgId as any,
        name: "Connection 2",
        localPublicKey: keyPair2.publicKey,
        localPrivateKey: keyPair2.privateKey,
      },
    ]);

    // List connections
    const conns = await listConnections(testOrgId);

    expect(conns.length).toBeGreaterThanOrEqual(2);
    expect(conns.some((c) => c.name === "Connection 1")).toBe(true);
    expect(conns.some((c) => c.name === "Connection 2")).toBe(true);
  });

  test("listConnections should return empty for organisation with no connections", async () => {
    const conns = await listConnections(
      "00000000-0000-0000-0000-000000000777"
    );

    expect(conns).toHaveLength(0);
  });

  /**
   * Test: listConnectionSessions
   */
  test("listConnectionSessions should return all sessions for connection", async () => {
    const db = getDb();

    // Create connection
    const keyPair = generateKeyPair();
    const connResult = await db
      .insert(connections)
      .values({
        organisationId: TEST_ORG_ID as any,
        name: "Sessions Test",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    const connectionId = connResult[0]?.id;
    expect(connectionId).toBeDefined();

    // Create multiple sessions
    const session1 = await createConnectionSession(connectionId!);
    const session2 = await createConnectionSession(connectionId!);

    // List sessions
    const sessions = await listConnectionSessions(connectionId!);

    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.some((s) => s.id === session1.id)).toBe(true);
    expect(sessions.some((s) => s.id === session2.id)).toBe(true);
  });

  test("listConnectionSessions should return empty for connection with no sessions", async () => {
    const db = getDb();

    // Create connection
    const keyPair = generateKeyPair();
    const connResult = await db
      .insert(connections)
      .values({
        organisationId: TEST_ORG_ID as any,
        name: "No Sessions",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    // List sessions (should be empty)
    const sessions = await listConnectionSessions(connResult[0]?.id || "");

    expect(sessions).toHaveLength(0);
  });

  /**
   * Test: updateSessionHeartbeat
   */
  test("updateSessionHeartbeat should update lastHeartbeat", async () => {
    const db = getDb();

    // Create connection and session
    const keyPair = generateKeyPair();
    const connResult = await db
      .insert(connections)
      .values({
        organisationId: TEST_ORG_ID as any,
        name: "Heartbeat Test",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    const connectionId = connResult[0]?.id;
    expect(connectionId).toBeDefined();

    const session = await createConnectionSession(connectionId!);
    const originalHeartbeat = session.lastHeartbeat;

    // Wait a bit and update
    await new Promise((resolve) => setTimeout(resolve, 100));
    await updateSessionHeartbeat(session.id);

    // Verify heartbeat was updated
    const updated = await db
      .select()
      .from(connectionSessions)
      .where(eq(connectionSessions.id, session.id as any));

    expect(updated[0]?.lastHeartbeat).not.toBe(originalHeartbeat);
    expect((updated[0]?.lastHeartbeat || "").localeCompare(originalHeartbeat)).toBeGreaterThan(0);
  });

  /**
   * Test: dropConnectionSession
   */
  test("dropConnectionSession should delete session", async () => {
    const db = getDb();

    // Create connection and session
    const keyPair = generateKeyPair();
    const connResult = await db
      .insert(connections)
      .values({
        organisationId: TEST_ORG_ID as any,
        name: "Drop Session Test",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    const connectionId = connResult[0]?.id;
    expect(connectionId).toBeDefined();

    const session = await createConnectionSession(connectionId!);
    const sessionId = session.id;

    // Drop session
    await dropConnectionSession(sessionId);

    // Verify deleted
    const deleted = await db
      .select()
      .from(connectionSessions)
      .where(eq(connectionSessions.id, sessionId as any));

    expect(deleted).toHaveLength(0);
  });

  /**
   * Test: dropConnection
   */
  test("dropConnection should delete connection and all sessions", async () => {
    const db = getDb();

    // Create connection
    const keyPair = generateKeyPair();
    const connResult = await db
      .insert(connections)
      .values({
        organisationId: TEST_ORG_ID as any,
        name: "Drop Connection Test",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    const connectionId = connResult[0]?.id;
    expect(connectionId).toBeDefined();

    // Create sessions
    const session1 = await createConnectionSession(connectionId!);
    const session2 = await createConnectionSession(connectionId!);

    // Drop connection
    await dropConnection(connectionId!);

    // Verify connection deleted
    const connDeleted = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId as any));

    expect(connDeleted).toHaveLength(0);

    // Verify sessions deleted (cascade)
    const allSessions = await db.select().from(connectionSessions);
    expect(allSessions.some((s) => s.id === session1.id)).toBe(false);
    expect(allSessions.some((s) => s.id === session2.id)).toBe(false);
  });

  /**
   * Test: connectionsService singleton
   */
  test("connectionsService should export all methods", () => {
    expect(connectionsService.generateKeyPair).toBeDefined();
    expect(connectionsService.validateRemoteCredentials).toBeDefined();
    expect(connectionsService.initializeConnection).toBeDefined();
    expect(connectionsService.createConnectionSession).toBeDefined();
    expect(connectionsService.getConnection).toBeDefined();
    expect(connectionsService.getConnectionByOrganisations).toBeDefined();
    expect(connectionsService.listConnections).toBeDefined();
    expect(connectionsService.listConnectionSessions).toBeDefined();
    expect(connectionsService.updateSessionHeartbeat).toBeDefined();
    expect(connectionsService.dropConnectionSession).toBeDefined();
    expect(connectionsService.dropConnection).toBeDefined();
    expect(connectionsService.authenticateConnectionSession).toBeDefined();
  });
});
