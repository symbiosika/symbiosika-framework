/**
 * Connections Service Tests
 * Tests for server-to-server connection business logic
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { connections } from "../db/db-schema";
import { eq } from "drizzle-orm";
import {
  connectionsService,
  generateKeyPair,
  validateRemoteCredentials,
  initializeConnection,
  acceptConnection,
  getConnection,
  dropConnection,
  getConnectionByTenants,
  getConnectionByLocalTenant,
} from "./index";

const TEST_ORG_ID = TEST_ORGANISATION_1.id;
const TEST_REMOTE_ORG_ID = "00000000-0000-0000-0000-000000000001";
const TEST_REMOTE_URL = "https://localhost/api/v1";
const TEST_CONNECTION_NAME = "Test Connection";

beforeAll(async () => {
  await initTests();
  // delete all old connections
  await getDb()
    .delete(connections)
    .where(eq(connections.tenantId, TEST_ORG_ID));
  await getDb()
    .delete(connections)
    .where(eq(connections.remoteTenantId, TEST_ORG_ID));
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
  test("validateRemoteCredentials should fetch and return tenants", async () => {
    const mockOrgData = [
      { id: TEST_REMOTE_ORG_ID, name: "Remote Organisation" },
    ];

    // Mock fetch for login endpoint
    const originalFetch = global.fetch;
    (global as any).fetch = async (url: string, _options?: RequestInit) => {
      if (url.includes("/user/login")) {
        return {
          ok: true,
          json: async () => ({ token: "test-token" }),
        } as Response;
      } else if (url.includes("/user/tenants")) {
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
      expect(result.tenants).toHaveLength(1);
      expect((result.tenants[0] as any)?.id).toBe(TEST_REMOTE_ORG_ID);
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
        await validateRemoteCredentials(
          TEST_REMOTE_URL,
          "wrong@example.com",
          "wrong"
        );
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
        await validateRemoteCredentials(
          TEST_REMOTE_URL,
          "test@example.com",
          "password"
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
      } else if (url.includes("/user/tenants")) {
        return {
          ok: true,
          json: async () => [{ id: TEST_REMOTE_ORG_ID, name: "Remote Org" }],
        } as Response;
      } else if (url.includes("/exchange-keys")) {
        return {
          ok: true,
          json: async () => ({
            localPublicKey:
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
      expect(conn?.tenantId).toBe(TEST_ORG_ID as any);
      expect(conn?.remoteTenantId).toBe(TEST_REMOTE_ORG_ID as any);
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
      } else if (url.includes("/user/tenants")) {
        return {
          ok: true,
          json: async () => [{ id: TEST_REMOTE_ORG_ID, name: "Remote Org" }],
        } as Response;
      } else if (url.includes("/exchange-keys")) {
        return {
          ok: true,
          json: async () => ({
            localPublicKey:
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

  test("initializeConnection should throw on invalid remote tenant", async () => {
    const originalFetch = global.fetch;
    (global as any).fetch = async (url: string) => {
      if (url.includes("/user/login")) {
        return {
          ok: true,
          json: async () => ({ token: "test-token" }),
        } as Response;
      } else if (url.includes("/user/tenants")) {
        return {
          ok: true,
          json: async () => ({ tenants: [] }),
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
   * Test: acceptConnection
   */
  test("acceptConnection should create connection from remote initiation", async () => {
    const db = getDb();
    const { publicKey: remotePublicKey } = generateKeyPair();
    const id = crypto.randomUUID();
    // Use a unique remote org ID to avoid constraint violation
    const uniqueRemoteOrgId = "00000000-0000-0000-0000-000000000999";

    const result = await acceptConnection(
      TEST_ORG_ID,
      TEST_REMOTE_URL,
      uniqueRemoteOrgId,
      id,
      remotePublicKey,
      "Accepted Connection"
    );

    expect(result).toBeDefined();
    expect(result.connectionId).toBeDefined();
    expect(result.localPublicKey).toContain("BEGIN PUBLIC KEY");

    // Verify in database
    const conn = await getConnection(result.connectionId);
    expect(conn).toBeDefined();
    expect(conn?.name).toBe("Accepted Connection");
    expect(conn?.tenantId).toBe(TEST_ORG_ID as any);
    expect(conn?.remoteTenantId).toBe(uniqueRemoteOrgId as any);
    expect(conn?.remoteConnectionId).toBe(id);
    expect(conn?.remotePublicKey).toBe(remotePublicKey);
    expect(conn?.initiatedBy).toBe("remote");
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
        tenantId: TEST_ORG_ID as any,
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
    const conn = await getConnection("00000000-0000-0000-0000-000000000999");

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
        tenantId: TEST_ORG_ID,
        remoteTenantId: TEST_ORG_ID,
        name: "Org Connection",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    // Retrieve by tenants
    const conn = await getConnectionByTenants(TEST_ORG_ID, TEST_ORG_ID);

    expect(conn).toBeDefined();
    expect(conn?.id).toBe(connResult[0]?.id);
  });

  test("getConnectionByOrganisations should return null for non-existent combination", async () => {
    const conn = await getConnectionByTenants(
      "00000000-0000-0000-0000-000000000888",
      "00000000-0000-0000-0000-000000000999"
    );

    expect(conn).toBeNull();
  });

  /**
   * Test: getConnectionByLocalOrganisation
   */
  test("getConnectionByLocalOrganisation should return all connections for tenant", async () => {
    const db = getDb();

    // Create multiple connections
    const keyPair1 = generateKeyPair();
    const keyPair2 = generateKeyPair();

    await db.insert(connections).values([
      {
        tenantId: TEST_ORG_ID as any,
        name: "Connection 1",
        localPublicKey: keyPair1.publicKey,
        localPrivateKey: keyPair1.privateKey,
      },
      {
        tenantId: TEST_ORG_ID as any,
        name: "Connection 2",
        localPublicKey: keyPair2.publicKey,
        localPrivateKey: keyPair2.privateKey,
      },
    ]);

    // List connections
    const conns = await getConnectionByLocalTenant(TEST_ORG_ID);

    expect(conns.length).toBeGreaterThanOrEqual(2);
    expect(conns.some((c: any) => c.name === "Connection 1")).toBe(true);
    expect(conns.some((c: any) => c.name === "Connection 2")).toBe(true);
  });

  test("getConnectionByLocalOrganisation should return empty for tenant with no connections", async () => {
    const conns = await getConnectionByLocalTenant(
      "00000000-0000-0000-0000-000000000777"
    );

    expect(conns).toHaveLength(0);
  });

  /**
   * Test: dropConnection
   */
  test("dropConnection should delete connection", async () => {
    const db = getDb();

    // Create connection
    const keyPair = generateKeyPair();
    const connResult = await db
      .insert(connections)
      .values({
        tenantId: TEST_ORG_ID as any,
        name: "Drop Connection Test",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
      })
      .returning();

    const connectionId = connResult[0]?.id;
    expect(connectionId).toBeDefined();

    // Drop connection
    await dropConnection(connectionId!);

    // Verify connection deleted
    const connDeleted = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId as any));

    expect(connDeleted).toHaveLength(0);
  });

  /**
   * Test: authenticateConnection and signatures
   */
  test("signData and verifySignature should work correctly", () => {
    const keyPair = generateKeyPair();
    const data = "test-data";
    const signature = connectionsService.signData(data, keyPair.privateKey);

    const isValid = connectionsService.verifySignature(
      data,
      signature,
      keyPair.publicKey
    );
    expect(isValid).toBe(true);

    const isInvalid = connectionsService.verifySignature(
      "tampered-data",
      signature,
      keyPair.publicKey
    );
    expect(isInvalid).toBe(false);
  });

  test("authenticateConnection should verify signature and return token", async () => {
    const db = getDb();
    const keyPair = generateKeyPair();
    // Mock a connection in DB with remote public key matching our keyPair
    const connResult = await db
      .insert(connections)
      .values({
        tenantId: TEST_ORG_ID as any,
        name: "Auth Connection Test",
        localPublicKey: "local-pub",
        localPrivateKey: "local-priv",
        remotePublicKey: keyPair.publicKey, // Remote matches our key
      })
      .returning();
    if (!connResult[0]) {
      throw new Error("Failed to create auth connection");
    }
    const connectionId = connResult[0].id;

    // Sign data
    const timestamp = Date.now();
    const data = `${connectionId}:${timestamp}`;
    const signature = connectionsService.signData(data, keyPair.privateKey);

    const result = await connectionsService.authenticateConnection(
      connectionId,
      timestamp,
      signature
    );

    expect(result.token).toBeDefined();

    // Clean up
    await dropConnection(connectionId);
  });

  test("cleanupStaleConnections should remove old connections", async () => {
    const db = getDb();
    const keyPair = generateKeyPair();

    // Create stale connection
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100); // 100 days ago

    const connResult = await db
      .insert(connections)
      .values({
        tenantId: TEST_ORG_ID as any,
        name: "Stale Connection",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
        lastConnectedAt: oldDate.toISOString(),
      })
      .returning();
    if (!connResult[0]) {
      throw new Error("Failed to create stale connection");
    }
    const staleId = connResult[0].id;

    // Create active connection
    const activeResult = await db
      .insert(connections)
      .values({
        tenantId: TEST_ORG_ID as any,
        name: "Active Connection",
        localPublicKey: keyPair.publicKey,
        localPrivateKey: keyPair.privateKey,
        lastConnectedAt: new Date().toISOString(),
      })
      .returning();
    if (!activeResult[0]) {
      throw new Error("Failed to create active connection");
    }
    const activeId = activeResult[0].id;

    // Cleanup older than 30 days
    const cleanedCount = await connectionsService.cleanupStaleConnections(30);
    expect(cleanedCount).toBeGreaterThanOrEqual(1);

    const staleConn = await getConnection(staleId);
    expect(staleConn).toBeNull();

    const activeConn = await getConnection(activeId);
    expect(activeConn).toBeDefined();

    // Clean up
    await dropConnection(activeId);
  });

  /**
   * Test: connectionsService singleton
   */
  test("connectionsService should export all methods", () => {
    expect(connectionsService.generateKeyPair).toBeDefined();
    expect(connectionsService.validateRemoteCredentials).toBeDefined();
    expect(connectionsService.initializeConnection).toBeDefined();
    expect(connectionsService.acceptConnection).toBeDefined();
    expect(connectionsService.getConnection).toBeDefined();
    expect(connectionsService.getConnectionByTenants).toBeDefined();
    expect(connectionsService.getConnectionByLocalTenant).toBeDefined();
    expect(connectionsService.dropConnection).toBeDefined();
  });
});
