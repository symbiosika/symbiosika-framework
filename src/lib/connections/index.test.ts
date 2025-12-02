/**
 * Connections Service Tests
 * Tests for server-to-server connection business logic
 */

import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { connections, tenants, serverKeys } from "../db/db-schema";
import { eq, and, or, ne } from "drizzle-orm";
import {
  connectionsService,
  generateKeyPair,
  validateRemoteCredentials,
  initializeConnection,
  acceptConnection,
  getConnection,
  dropConnection,
  getConnectionByTenantAndName,
  getConnectionByClientId,
  getConnectionByLocalTenant,
} from "./index";
import { initServerKeysIfNeeded, getServerKeys } from "./init-server-keys";

const TEST_ORG_ID = TEST_ORGANISATION_1.id;
const TEST_REMOTE_ORG_ID = "00000000-0000-0000-0000-000000000001";
const TEST_REMOTE_URL = "https://localhost/api/v1";
const TEST_CONNECTION_NAME = "Test Connection";

beforeAll(async () => {
  await initTests();
  // Initialize server keys if needed
  await initServerKeysIfNeeded();
  // delete all old connections (clean up before tests)
  await getDb().delete(connections);
  // Clean up test tenants
  await getDb().delete(tenants).where(eq(tenants.id, TEST_REMOTE_ORG_ID));
});

afterEach(async () => {
  // Clean up any additional server keys created during tests
  // Keep only the main server key (the first one created)
  const db = getDb();
  const allKeys = await db.select().from(serverKeys);
  if (allKeys.length > 1) {
    // Delete all except the first one (main server key)
    const mainKeyId = allKeys[0]!.id;
    await db.delete(serverKeys).where(ne(serverKeys.id, mainKeyId));
  }
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
      {
        tenantId: TEST_REMOTE_ORG_ID,
        name: "Remote Organisation",
        role: "admin",
      },
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
      expect((result.tenants[0] as any)?.tenantId).toBe(TEST_REMOTE_ORG_ID);
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
          json: async () => [
            { tenantId: TEST_REMOTE_ORG_ID, name: "Remote Org", role: "admin" },
          ],
        } as Response;
      } else if (url.includes("/exchange-keys")) {
        return {
          ok: true,
          json: async () => ({
            localPublicKey:
              "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
            serverId: "test-server-id",
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
      expect(conn?.tenantId).toBe(TEST_REMOTE_ORG_ID as any); // Remote tenant ID is now used as tenantId
      expect(conn?.initiatedBy).toBe("local");
      expect(conn?.clientId).toBeDefined();

      // Verify tenant was created locally
      const tenant = await getDb()
        .select()
        .from(tenants)
        .where(eq(tenants.id, TEST_REMOTE_ORG_ID))
        .limit(1);
      expect(tenant[0]).toBeDefined();
      expect(tenant[0]?.name).toBe("Remote Org");
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  test("initializeConnection should update existing local connection", async () => {
    const originalFetch = global.fetch;
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error("Server keys not found");
    }

    (global as any).fetch = async (url: string) => {
      if (url.includes("/user/login")) {
        return {
          ok: true,
          json: async () => ({ token: "test-token" }),
        } as Response;
      } else if (url.includes("/user/tenants")) {
        return {
          ok: true,
          json: async () => [
            { tenantId: TEST_REMOTE_ORG_ID, name: "Remote Org", role: "admin" },
          ],
        } as Response;
      } else if (url.includes("/exchange-keys")) {
        return {
          ok: true,
          json: async () => ({
            localPublicKey:
              "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
            serverId: "test-server-id",
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

      // Initialize again - should update existing local connection
      const result2 = await initializeConnection(
        TEST_ORG_ID,
        TEST_REMOTE_URL,
        "admin@remote.com",
        "password123",
        TEST_REMOTE_ORG_ID,
        "Updated Name"
      );

      // Should return same connection ID (upsert based on clientId + initiatedBy)
      expect(result2.connectionId).toBe(originalId);

      // Verify updated name
      const conn = await getConnection(result2.connectionId);
      expect(conn?.name).toBe("Updated Name");
      expect(conn?.clientId).toBe(serverKey.id);
      expect(conn?.initiatedBy).toBe("local");
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
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error("Server keys not found");
    }

    // Create a new server key for the test client (must exist in server_keys)
    const clientKeyPair = generateKeyPair();
    const clientServerKey = await db
      .insert(serverKeys)
      .values({
        privateKey: clientKeyPair.privateKey,
        publicKey: clientKeyPair.publicKey,
      })
      .returning();

    if (!clientServerKey[0]) {
      throw new Error("Failed to create client server key");
    }
    const clientId = clientServerKey[0].id; // Use real server key ID

    const { publicKey: remotePublicKey } = generateKeyPair();
    // Use a unique remote org ID to avoid constraint violation
    const uniqueRemoteOrgId = "00000000-0000-0000-0000-000000000999";

    const result = await acceptConnection(
      TEST_ORG_ID,
      TEST_REMOTE_URL,
      uniqueRemoteOrgId,
      clientId, // Client's serverId (must exist in server_keys)
      remotePublicKey,
      "Accepted Connection",
      "Remote Tenant Name"
    );

    expect(result).toBeDefined();
    expect(result.connectionId).toBeDefined();
    expect(result.localPublicKey).toContain("BEGIN PUBLIC KEY");

    // Verify in database
    const conn = await getConnection(result.connectionId);
    expect(conn).toBeDefined();
    expect(conn?.name).toBe("Accepted Connection");
    expect(conn?.tenantId).toBe(uniqueRemoteOrgId as any); // Remote tenant ID is now used as tenantId
    expect(conn?.clientId).toBe(clientId);
    expect(conn?.remotePublicKey).toBe(remotePublicKey);
    expect(conn?.initiatedBy).toBe("remote");

    // Verify tenant was created locally
    const tenant = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, uniqueRemoteOrgId))
      .limit(1);
    expect(tenant[0]).toBeDefined();
    expect(tenant[0]?.name).toBe("Remote Tenant Name");

    // Clean up
    await db.delete(connections).where(eq(connections.id, result.connectionId));
    await db.delete(tenants).where(eq(tenants.id, uniqueRemoteOrgId));
    await db.delete(serverKeys).where(eq(serverKeys.id, clientId));
  });

  /**
   * Test: getConnection
   */
  test("getConnection should retrieve connection by ID", async () => {
    const db = getDb();
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error("Server keys not found");
    }

    // Delete any existing connection with same clientId and initiatedBy
    await db
      .delete(connections)
      .where(
        and(
          eq(connections.clientId, serverKey.id),
          eq(connections.initiatedBy, "local")
        )
      );

    // Create connection
    const connResult = await db
      .insert(connections)
      .values({
        tenantId: TEST_ORG_ID as any,
        name: "Get Test Connection",
        clientId: serverKey.id,
        initiatedBy: "local",
      })
      .returning();

    const connectionId = connResult[0]?.id;
    expect(connectionId).toBeDefined();

    // Retrieve it
    const conn = await getConnection(connectionId!);

    expect(conn).toBeDefined();
    expect(conn?.id).toBe(connectionId);
    expect(conn?.name).toBe("Get Test Connection");
    expect(conn?.clientId).toBe(serverKey.id);

    // Clean up
    await db.delete(connections).where(eq(connections.id, connectionId!));
  });

  test("getConnection should return null for non-existent connection", async () => {
    const conn = await getConnection("00000000-0000-0000-0000-000000000999");

    expect(conn).toBeNull();
  });

  /**
   * Test: getConnectionByTenantAndName
   */
  test("getConnectionByTenantAndName should retrieve connection", async () => {
    const db = getDb();
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error("Server keys not found");
    }

    // Delete any existing connection with same clientId and initiatedBy
    await db
      .delete(connections)
      .where(
        and(
          eq(connections.clientId, serverKey.id),
          eq(connections.initiatedBy, "local")
        )
      );

    // Create connection
    const connResult = await db
      .insert(connections)
      .values({
        tenantId: TEST_ORG_ID,
        name: "Org Connection",
        clientId: serverKey.id,
        initiatedBy: "local",
      })
      .returning();

    // Retrieve by tenant and name
    const conn = await getConnectionByTenantAndName(
      TEST_ORG_ID,
      "Org Connection"
    );

    expect(conn).toBeDefined();
    expect(conn?.id).toBe(connResult[0]?.id);

    // Clean up
    await db.delete(connections).where(eq(connections.id, connResult[0]!.id));
  });

  test("getConnectionByTenantAndName should return null for non-existent combination", async () => {
    const conn = await getConnectionByTenantAndName(
      "00000000-0000-0000-0000-000000000888",
      "Non-existent Connection"
    );

    expect(conn).toBeNull();
  });

  /**
   * Test: getConnectionByLocalOrganisation
   */
  test("getConnectionByLocalOrganisation should return all connections for tenant", async () => {
    const db = getDb();
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error("Server keys not found");
    }

    // Create a second server key for remote connection
    const remoteKeyPair = generateKeyPair();
    const remoteServerKey = await db
      .insert(serverKeys)
      .values({
        privateKey: remoteKeyPair.privateKey,
        publicKey: remoteKeyPair.publicKey,
      })
      .returning();

    if (!remoteServerKey[0]) {
      throw new Error("Failed to create remote server key");
    }

    // Delete any existing connections
    await db
      .delete(connections)
      .where(eq(connections.tenantId, TEST_ORG_ID));

    // Create multiple connections with different clientIds
    const connResults = await db.insert(connections).values([
      {
        tenantId: TEST_ORG_ID as any,
        name: "Connection 1",
        clientId: serverKey.id,
        initiatedBy: "local",
      },
      {
        tenantId: TEST_ORG_ID as any,
        name: "Connection 2",
        clientId: remoteServerKey[0].id, // Different clientId
        initiatedBy: "remote",
      },
    ]).returning();

    // List connections
    const conns = await getConnectionByLocalTenant(TEST_ORG_ID);

    expect(conns.length).toBeGreaterThanOrEqual(2);
    expect(conns.some((c: any) => c.name === "Connection 1")).toBe(true);
    expect(conns.some((c: any) => c.name === "Connection 2")).toBe(true);

    // Clean up
    await db.delete(connections).where(eq(connections.tenantId, TEST_ORG_ID));
    await db.delete(serverKeys).where(eq(serverKeys.id, remoteServerKey[0].id));
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
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error("Server keys not found");
    }

    // Delete any existing connection with same clientId and initiatedBy
    await db
      .delete(connections)
      .where(
        and(
          eq(connections.clientId, serverKey.id),
          eq(connections.initiatedBy, "local")
        )
      );

    // Create connection
    const connResult = await db
      .insert(connections)
      .values({
        tenantId: TEST_ORG_ID as any,
        name: "Drop Connection Test",
        clientId: serverKey.id,
        initiatedBy: "local",
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
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error("Server keys not found");
    }

    // Create a new server key for the test client (must exist in server_keys)
    const clientKeyPair = generateKeyPair();
    const clientServerKey = await db
      .insert(serverKeys)
      .values({
        privateKey: clientKeyPair.privateKey,
        publicKey: clientKeyPair.publicKey,
      })
      .returning();

    if (!clientServerKey[0]) {
      throw new Error("Failed to create client server key");
    }
    const clientId = clientServerKey[0].id; // Use real server key ID

    const keyPair = generateKeyPair();

    // Mock a connection in DB with remote public key matching our keyPair
    const connResult = await db
      .insert(connections)
      .values({
        tenantId: TEST_ORG_ID as any,
        name: "Auth Connection Test",
        clientId: clientId,
        initiatedBy: "remote",
        remotePublicKey: keyPair.publicKey, // Remote matches our key
      })
      .returning();
    if (!connResult[0]) {
      throw new Error("Failed to create auth connection");
    }

    // Sign data with clientId (not connectionId)
    const timestamp = Date.now();
    const data = `${clientId}:${timestamp}`;
    const signature = connectionsService.signData(data, keyPair.privateKey);

    const result = await connectionsService.authenticateConnection(
      TEST_ORG_ID,
      clientId,
      timestamp,
      signature
    );

    expect(result.token).toBeDefined();

    // Clean up
    await dropConnection(connResult[0].id);
    await db.delete(serverKeys).where(eq(serverKeys.id, clientId));
  });

  test("cleanupStaleConnections should remove old connections", async () => {
    const db = getDb();
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error("Server keys not found");
    }

    // Create a second server key for remote connection
    const remoteKeyPair = generateKeyPair();
    const remoteServerKey = await db
      .insert(serverKeys)
      .values({
        privateKey: remoteKeyPair.privateKey,
        publicKey: remoteKeyPair.publicKey,
      })
      .returning();

    if (!remoteServerKey[0]) {
      throw new Error("Failed to create remote server key");
    }

    // Delete any existing connections
    await db
      .delete(connections)
      .where(
        and(
          eq(connections.tenantId, TEST_ORG_ID),
          or(
            eq(connections.clientId, serverKey.id),
            eq(connections.clientId, remoteServerKey[0].id)
          )
        )
      );

    // Create stale connection
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100); // 100 days ago

    const connResult = await db
      .insert(connections)
      .values({
        tenantId: TEST_ORG_ID as any,
        name: "Stale Connection",
        clientId: serverKey.id,
        initiatedBy: "local",
        lastConnectedAt: oldDate.toISOString(),
      })
      .returning();
    if (!connResult[0]) {
      throw new Error("Failed to create stale connection");
    }
    const staleId = connResult[0].id;

    // Create active connection with different clientId
    const activeResult = await db
      .insert(connections)
      .values({
        tenantId: TEST_ORG_ID as any,
        name: "Active Connection",
        clientId: remoteServerKey[0].id, // Different clientId
        initiatedBy: "remote",
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
    await db.delete(serverKeys).where(eq(serverKeys.id, remoteServerKey[0].id));
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
    expect(connectionsService.getConnectionByTenantAndName).toBeDefined();
    expect(connectionsService.getConnectionByClientId).toBeDefined();
    expect(connectionsService.getConnectionByLocalTenant).toBeDefined();
    expect(connectionsService.dropConnection).toBeDefined();
    expect(connectionsService.authenticateConnection).toBeDefined();
    expect(connectionsService.verifyConnection).toBeDefined();
    expect(connectionsService.refreshConnection).toBeDefined();
  });
});
