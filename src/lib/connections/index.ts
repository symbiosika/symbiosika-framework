/**
 * Connections Service
 * Manages server-to-server connections with cryptographic key exchange
 * 
 * Architecture:
 * - Each connection has a unique remoteConnectionId that matches on both sides
 * - Connections are bidirectional: one record per direction (local->remote, remote->local)
 * - Uses server keys for signing/verification
 */

import { getDb } from "../db/db-connection";
import {
  connections,
  type ConnectionsInsert,
  type ConnectionsSelect,
  tenants,
} from "../db/db-schema";
import { eq, and, lt, isNotNull } from "drizzle-orm";
import log from "../log";
import { generateKeyPairSync, sign, verify, randomUUID } from "node:crypto";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { generateJwt } from "../auth";
import { getServerKeys } from "./init-server-keys";
import { getTenant, updateTenant } from "../usermanagement/tenants";

// ============================================================================
// Types
// ============================================================================

export interface RemoteTenantInfo {
  tenantId: string;
  name: string;
  role: string;
}

export interface ConnectionInitResult {
  connectionId: string;
  remoteConnectionId: string;
  localPublicKey: string;
  remotePublicKey: string;
  status: "active";
}

export interface ConnectionAcceptResult {
  connectionId: string;
  remoteConnectionId: string;
  localPublicKey: string;
}

export interface AuthenticationResult {
  token: string;
}

// ============================================================================
// Cryptographic Functions
// ============================================================================

/**
 * Generate RSA key pair for connection
 */
export function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  return {
    publicKey,
    privateKey,
  };
}

/**
 * Sign data with private key
 */
export function signData(data: string, privateKey: string): string {
  const buffer = Buffer.from(data);
  const signature = sign("sha256", buffer, privateKey);
  return signature.toString("base64");
}

/**
 * Verify signature with public key
 */
export function verifySignature(
  data: string,
  signature: string,
  publicKey: string
): boolean {
  try {
    const buffer = Buffer.from(data);
    const signatureBuffer = Buffer.from(signature, "base64");
    return verify("sha256", buffer, publicKey, signatureBuffer);
  } catch (error) {
    log.error("Signature verification error:", error as object);
    return false;
  }
}

// ============================================================================
// Remote Server Communication
// ============================================================================

/**
 * Validate remote server credentials and retrieve tenants
 */
export async function validateRemoteCredentials(
  remoteUrl: string,
  email: string,
  password: string
): Promise<{ token: string; tenants: RemoteTenantInfo[] }> {
  try {
    // Validate remote URL format
    if (!remoteUrl || !remoteUrl.startsWith("http")) {
      throw new Error("Invalid remote URL format");
    }

    // Authenticate with remote server
    const loginResponse = await fetch(`${remoteUrl}/api/v1/user/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });

    if (!loginResponse.ok) {
      const errorText = await loginResponse.text().catch(() => "Unknown error");
      throw new Error(
        `Failed to authenticate: ${loginResponse.status} ${errorText}`
      );
    }

    const loginData = (await loginResponse.json()) as { token?: string };

    if (!loginData.token) {
      throw new Error("No authentication token received from remote server");
    }

    // Fetch user's tenants from remote server
    const tenantsResponse = await fetch(`${remoteUrl}/api/v1/user/tenants`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${loginData.token}`,
      },
    });

    if (!tenantsResponse.ok) {
      const errorText = await tenantsResponse.text().catch(() => "Unknown error");
      throw new Error(
        `Failed to fetch tenants: ${tenantsResponse.status} ${errorText}`
      );
    }

    const tenants = (await tenantsResponse.json()) as RemoteTenantInfo[];

    return {
      token: loginData.token,
      tenants: tenants || [],
    };
  } catch (error) {
    log.error("Error validating remote credentials:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to validate remote credentials");
  }
}

/**
 * Exchange public keys with remote server
 * Called during connection initialization to complete the handshake
 */
async function exchangePublicKeys(
  remoteUrl: string,
  token: string,
  remoteTenantId: string,
  localPublicKey: string,
  remoteConnectionId: string,
  localServerUrl: string,
  connectionName: string,
  localTenantId: string,
  localTenantName: string
): Promise<{ remotePublicKey: string }> {
  try {
    const exchangeUrl = `${remoteUrl}/api/v1/tenant/${remoteTenantId}/connections/exchange-keys`;
    log.info(
      `Sending exchange-keys request to: ${exchangeUrl}, remoteTenantId=${remoteTenantId}, localTenantId=${localTenantId}, remoteConnectionId=${remoteConnectionId}`
    );

    const response = await fetch(exchangeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        remotePublicKey: localPublicKey,
        remoteConnectionId: remoteConnectionId,
        remoteTenantId: localTenantId,
        remoteTenantName: localTenantName,
        remoteUrl: localServerUrl,
        connectionName: connectionName,
      }),
    });

    log.info(
      `exchange-keys response status: ${response.status} ${response.statusText}`
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Failed to exchange public keys: ${response.status} ${errorText}`
      );
    }

    const data = (await response.json()) as {
      connectionId?: string;
      localPublicKey?: string;
    };

    if (!data.localPublicKey) {
      throw new Error("No public key received from remote server");
    }

    return {
      remotePublicKey: data.localPublicKey,
    };
  } catch (error) {
    log.error("Error exchanging public keys:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to exchange public keys");
  }
}

// ============================================================================
// Connection Management
// ============================================================================

/**
 * Initialize connection with remote server
 * 
 * Flow:
 * 1. Validate remote credentials
 * 2. Create/update remote tenant locally
 * 3. Create connection record with generated remoteConnectionId
 * 4. Exchange public keys with remote server
 * 5. Update connection with remote public key
 * 
 * @param localTenantId - The tenant ID initiating the connection
 * @param remoteUrl - URL of the remote server
 * @param remoteEmail - Email for remote authentication
 * @param remotePassword - Password for remote authentication
 * @param remoteTenantId - Tenant ID on remote server
 * @param name - Name for the connection
 */
export async function initializeConnection(
  localTenantId: string,
  remoteUrl: string,
  remoteEmail: string,
  remotePassword: string,
  remoteTenantId: string,
  name: string
): Promise<ConnectionInitResult> {
  const db = getDb();

  try {
    // Validate inputs
    if (!localTenantId || !remoteUrl || !remoteTenantId || !name) {
      throw new Error("Missing required parameters for connection initialization");
    }

    // Get server keys (must exist)
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error(
        "Server keys not found. Please ensure server has been started at least once."
      );
    }

    // Get local tenant info for exchange
    const localTenant = await getTenant(localTenantId);
    if (!localTenant) {
      throw new Error(`Local tenant ${localTenantId} not found`);
    }

    // Validate remote credentials and get tenant list
    const { token, tenants: remoteTenants } = await validateRemoteCredentials(
      remoteUrl,
      remoteEmail,
      remotePassword
    );

    // Verify remote tenant exists
    const remoteTenant = remoteTenants.find(
      (t) => t.tenantId === remoteTenantId
    );
    if (!remoteTenant) {
      throw new Error(
        `Remote tenant ${remoteTenantId} not found on remote server`
      );
    }

    // Create or update remote tenant locally (with same ID)
    await db
      .insert(tenants)
      .values({
        id: remoteTenantId,
        name: remoteTenant.name,
      })
      .onConflictDoUpdate({
        target: [tenants.id],
        set: {
          name: remoteTenant.name,
          updatedAt: new Date().toISOString(),
        },
      });
    log.info(
      `Created/updated local tenant ${remoteTenantId} with name: ${remoteTenant.name}`
    );

    // Generate connection ID (this will be our remoteConnectionId on the remote side)
    // We use a UUID that will be shared between both sides
    const remoteConnectionId = randomUUID();

    // Create connection record (initiated by local)
    // IMPORTANT: Store under localTenantId (the tenant initiating the connection),
    // not remoteTenantId. The remoteTenantId is just used to create/update the remote tenant locally.
    const newConnection: ConnectionsInsert = {
      tenantId: localTenantId, // Store under local tenant (the one initiating)
      remoteUrl: remoteUrl,
      name: name,
      initiatedBy: "local",
      remoteConnectionId: remoteConnectionId,
      remotePublicKey: null, // Will be set after key exchange
    };

    let connectionId: string;
    try {
      const result = await db
        .insert(connections)
        .values(newConnection)
        .onConflictDoUpdate({
          target: [connections.tenantId, connections.remoteConnectionId, connections.initiatedBy],
          set: {
            tenantId: newConnection.tenantId,
            remoteUrl: newConnection.remoteUrl,
            name: newConnection.name,
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();

      if (!result[0]) {
        throw new Error("Failed to create connection record");
      }

      connectionId = result[0].id;
      log.info(
        `Connection created/updated: ${connectionId} (remoteConnectionId: ${remoteConnectionId})`
      );
    } catch (error: any) {
      log.error("Database error creating connection:", error);
      throw new Error(
        `Failed to create connection: ${error?.message || "Unknown error"}`
      );
    }

    // Exchange public keys with remote server
    const localServerUrl = _GLOBAL_SERVER_CONFIG.baseUrl;
    if (!localServerUrl) {
      throw new Error("Local server URL not configured");
    }

    try {
      const exchangeResult = await exchangePublicKeys(
        remoteUrl,
        token,
        remoteTenantId,
        serverKey.publicKey,
        remoteConnectionId,
        localServerUrl,
        name,
        localTenantId,
        localTenant.name
      );

      // Update connection with remote public key
      await db
        .update(connections)
        .set({
          remotePublicKey: exchangeResult.remotePublicKey,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, connectionId));

      log.info(
        `Connection initialized successfully: ${connectionId} with remote public key`
      );

      return {
        connectionId,
        remoteConnectionId,
        localPublicKey: serverKey.publicKey,
        remotePublicKey: exchangeResult.remotePublicKey,
        status: "active",
      };
    } catch (error) {
      // If key exchange fails, clean up the connection
      log.error("Key exchange failed, cleaning up connection:", error as object);
      try {
        await db.delete(connections).where(eq(connections.id, connectionId));
      } catch (cleanupError) {
        log.error("Failed to cleanup connection after key exchange failure:", cleanupError as object);
      }
      throw error;
    }
  } catch (error) {
    log.error("Error initializing connection:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to initialize connection");
  }
}

/**
 * Accept connection request from remote server
 * 
 * Flow:
 * 1. Create/update remote tenant locally
 * 2. Create connection record (initiated by remote)
 * 3. Return local public key
 * 
 * @param localTenantId - The tenant ID accepting the connection
 * @param remoteUrl - URL of the remote server
 * @param remoteTenantId - Tenant ID on remote server
 * @param remoteConnectionId - Connection ID from remote server (must match on both sides)
 * @param remotePublicKey - Public key from remote server
 * @param connectionName - Name for the connection
 * @param remoteTenantName - Name of the remote tenant
 */
export async function acceptConnection(
  localTenantId: string,
  remoteUrl: string,
  remoteTenantId: string,
  remoteConnectionId: string,
  remotePublicKey: string,
  connectionName: string,
  remoteTenantName: string
): Promise<ConnectionAcceptResult> {
  const db = getDb();

  try {
    log.info(
      `acceptConnection called: localTenantId=${localTenantId}, remoteTenantId=${remoteTenantId}, remoteConnectionId=${remoteConnectionId}, connectionName=${connectionName}`
    );

    // Validate inputs
    if (
      !localTenantId ||
      !remoteUrl ||
      !remoteTenantId ||
      !remoteConnectionId ||
      !remotePublicKey ||
      !connectionName
    ) {
      throw new Error("Missing required parameters for connection acceptance");
    }

    // Get server keys (must exist)
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error(
        "Server keys not found. Please ensure server has been started at least once."
      );
    }

    // Verify local tenant exists
    const localTenant = await getTenant(localTenantId);
    if (!localTenant) {
      throw new Error(`Local tenant ${localTenantId} not found`);
    }
    log.info(`Local tenant verified: ${localTenantId} (${localTenant.name})`);

    // Create or update remote tenant locally (with same ID)
    const existingTenant = await getTenant(remoteTenantId);
    if (existingTenant) {
      // Update name if different
      if (existingTenant.name !== remoteTenantName) {
        await updateTenant(remoteTenantId, { name: remoteTenantName });
        log.info(
          `Updated local tenant ${remoteTenantId} with name: ${remoteTenantName}`
        );
      }
    } else {
      // Create tenant with same ID
      await db
        .insert(tenants)
        .values({
          id: remoteTenantId,
          name: remoteTenantName,
        })
        .onConflictDoUpdate({
          target: [tenants.id],
          set: {
            name: remoteTenantName,
            updatedAt: new Date().toISOString(),
          },
        });
      log.info(
        `Created local tenant ${remoteTenantId} with name: ${remoteTenantName}`
      );
    }

    // Create connection record (initiated by remote)
    // IMPORTANT: Store under localTenantId (the tenant accepting the connection),
    // not remoteTenantId. The remoteTenantId is the tenant on the remote server.
    const newConnection: ConnectionsInsert = {
      tenantId: localTenantId, // Store under local tenant (the one accepting)
      remoteUrl: remoteUrl,
      remotePublicKey: remotePublicKey,
      name: connectionName,
      initiatedBy: "remote",
      remoteConnectionId: remoteConnectionId, // Must match on both sides
    };

    let connectionId: string;
    try {
      const result = await db
        .insert(connections)
        .values(newConnection)
        .onConflictDoUpdate({
          target: [connections.tenantId, connections.remoteConnectionId, connections.initiatedBy],
          set: {
            tenantId: newConnection.tenantId,
            remoteUrl: newConnection.remoteUrl,
            name: newConnection.name,
            remotePublicKey: newConnection.remotePublicKey,
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();

      if (!result[0]) {
        throw new Error("Failed to create connection record");
      }

      connectionId = result[0].id;
      log.info(
        `Connection accepted and saved: connectionId=${connectionId}, tenantId=${newConnection.tenantId}, remoteConnectionId=${remoteConnectionId}, initiatedBy=${newConnection.initiatedBy}`
      );
    } catch (error: any) {
      log.error("Database error accepting connection:", error);
      throw new Error(
        `Failed to accept connection: ${error?.message || "Unknown error"}`
      );
    }

    return {
      connectionId,
      remoteConnectionId,
      localPublicKey: serverKey.publicKey,
    };
  } catch (error) {
    log.error("Error accepting connection:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to accept connection");
  }
}

/**
 * Authenticate a connection using signature
 * 
 * Flow:
 * 1. Verify timestamp (prevent replay attacks)
 * 2. Look up connection by remoteConnectionId
 * 3. Verify signature with stored public key
 * 4. Update lastConnectedAt
 * 5. Generate and return JWT token
 * 
 * @param tenantId - Tenant ID for the connection
 * @param remoteConnectionId - Connection ID from remote server
 * @param timestamp - Timestamp of the request
 * @param signature - Signature of the request
 */
export async function authenticateConnection(
  tenantId: string,
  remoteConnectionId: string,
  timestamp: number,
  signature: string
): Promise<AuthenticationResult> {
  try {
    // Validate inputs
    if (!tenantId || !remoteConnectionId || !timestamp || !signature) {
      throw new Error("Missing required authentication parameters");
    }

    // Check timestamp (prevent replay attacks, 5 minute window)
    const now = Date.now();
    const timeDiff = Math.abs(now - timestamp);
    if (timeDiff > 5 * 60 * 1000) {
      throw new Error(
        `Timestamp expired. Time difference: ${Math.round(timeDiff / 1000)}s`
      );
    }

    // Look up connection by remoteConnectionId
    const connection = await getConnectionByRemoteConnectionId(
      tenantId,
      remoteConnectionId
    );
    if (!connection) {
      throw new Error(
        `Connection not found for remoteConnectionId: ${remoteConnectionId}`
      );
    }

    if (!connection.remotePublicKey) {
      throw new Error(
        "No remote public key found for connection. Connection may not be fully initialized."
      );
    }

    // Verify signature
    // The data signed must match what the remote server signs: remoteConnectionId:timestamp
    const data = `${remoteConnectionId}:${timestamp}`;
    const isValid = verifySignature(
      data,
      signature,
      connection.remotePublicKey
    );

    if (!isValid) {
      throw new Error("Invalid signature");
    }

    // Update lastConnectedAt
    const db = getDb();
    await db
      .update(connections)
      .set({ lastConnectedAt: new Date().toISOString() })
      .where(eq(connections.id, connection.id));

    // Generate JWT token
    // We create a "system" user context for this connection
    const connectionUser = {
      id: connection.id,
      email: `connection+${connection.id}@system.local`,
      firstname: "System",
      surname: "Connection",
    };

    // Generate token valid for 1 hour
    const { token } = await generateJwt(connectionUser, 60 * 60, {
      connectionId: connection.id,
      tenantId: connection.tenantId,
      scope: "connection:sync",
      type: "connection",
    });

    log.info(`Connection authenticated: ${connection.id}`);

    return { token };
  } catch (error) {
    log.error("Error authenticating connection:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Authentication failed");
  }
}

/**
 * Verify connection by authenticating with remote server
 * 
 * Flow:
 * 1. Get connection record
 * 2. Sign a challenge with our private key
 * 3. Send to remote server for verification
 * 4. Return result
 * 
 * @param connectionId - Local connection ID
 */
export async function verifyConnection(
  connectionId: string
): Promise<{ token: string }> {
  try {
    // Get connection
    const connection = await getConnection(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    if (!connection.remoteConnectionId) {
      throw new Error("Connection remoteConnectionId not available");
    }

    if (!connection.remoteUrl) {
      throw new Error("Connection remote URL not available");
    }

    // Get server keys for signing
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error("Server keys not found");
    }

    // Sign payload using our server's private key
    const timestamp = Date.now();
    // The data signed must match what the server expects: remoteConnectionId:timestamp
    const data = `${connection.remoteConnectionId}:${timestamp}`;
    const signature = signData(data, serverKey.privateKey);

    // Send authentication request to remote server
    const response = await fetch(
      `${connection.remoteUrl}/api/v1/tenant/${connection.tenantId}/connections/authenticate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          remoteConnectionId: connection.remoteConnectionId,
          timestamp,
          signature,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Authentication failed: ${response.status} ${errorText}`
      );
    }

    const result = (await response.json()) as { token: string };
    return result;
  } catch (error) {
    log.error("Error verifying connection:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Connection verification failed");
  }
}

// ============================================================================
// Connection Queries
// ============================================================================

/**
 * Get connection by ID
 */
export async function getConnection(
  connectionId: string
): Promise<ConnectionsSelect | null> {
  try {
    const db = getDb();
    const result = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);

    return result[0] || null;
  } catch (error) {
    log.error("Error getting connection:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to get connection");
  }
}

/**
 * Get connection by tenant and name
 */
export async function getConnectionByTenantAndName(
  tenantId: string,
  name: string
): Promise<ConnectionsSelect | null> {
  try {
    const db = getDb();
    const result = await db
      .select()
      .from(connections)
      .where(and(eq(connections.tenantId, tenantId), eq(connections.name, name)))
      .limit(1);

    return result[0] || null;
  } catch (error) {
    log.error("Error getting connection by tenant and name:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to get connection");
  }
}

/**
 * Get connection by remote connection ID
 */
export async function getConnectionByRemoteConnectionId(
  tenantId: string,
  remoteConnectionId: string
): Promise<ConnectionsSelect | null> {
  try {
    const db = getDb();
    const result = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.tenantId, tenantId),
          eq(connections.remoteConnectionId, remoteConnectionId)
        )
      )
      .limit(1);

    return result[0] || null;
  } catch (error) {
    log.error(
      "Error getting connection by remote connection ID:",
      error as object
    );
    throw error instanceof Error
      ? error
      : new Error("Failed to get connection");
  }
}

/**
 * List all connections for a tenant
 */
export async function getConnectionByLocalTenant(
  tenantId: string,
  initiatedBy?: "local" | "remote"
): Promise<ConnectionsSelect[]> {
  try {
    const db = getDb();
    const conditions = [eq(connections.tenantId, tenantId)];
    
    if (initiatedBy) {
      conditions.push(eq(connections.initiatedBy, initiatedBy));
    }
    
    const result = await db
      .select()
      .from(connections)
      .where(and(...conditions));

    return result;
  } catch (error) {
    log.error("Error listing connections:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to list connections");
  }
}

/**
 * Drop connection
 */
export async function dropConnection(connectionId: string): Promise<void> {
  try {
    const db = getDb();

    // Verify connection exists
    const connection = await getConnection(connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    // Delete connection
    await db.delete(connections).where(eq(connections.id, connectionId));
    log.info(`Connection dropped: ${connectionId}`);
  } catch (error) {
    log.error("Error dropping connection:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to drop connection");
  }
}

/**
 * Refresh connection - update lastConnectedAt timestamp
 */
export async function refreshConnection(connectionId: string): Promise<void> {
  try {
    const db = getDb();

    // Verify connection exists
    const connection = await getConnection(connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    await db
      .update(connections)
      .set({
        lastConnectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(connections.id, connectionId));

    log.info(`Connection refreshed: ${connectionId}`);
  } catch (error) {
    log.error("Error refreshing connection:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to refresh connection");
  }
}

/**
 * Cleanup stale connections
 * Removes connections that haven't connected in the specified number of days
 */
export async function cleanupStaleConnections(
  days: number
): Promise<number> {
  try {
    const db = getDb();
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - days);
    const thresholdDateString = thresholdDate.toISOString();

    // Delete stale connections (only those with lastConnectedAt set and older than threshold)
    const result = await db
      .delete(connections)
      .where(
        and(
          isNotNull(connections.lastConnectedAt),
          lt(connections.lastConnectedAt, thresholdDateString)
        )
      )
      .returning();

    log.info(`Cleaned up ${result.length} stale connections`);
    return result.length;
  } catch (error) {
    log.error("Error cleaning up stale connections:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to cleanup stale connections");
  }
}

// ============================================================================
// Service Export
// ============================================================================

export const connectionsService = {
  // Cryptographic functions
  generateKeyPair,
  signData,
  verifySignature,

  // Remote server communication
  validateRemoteCredentials,

  // Connection management
  initializeConnection,
  acceptConnection,
  authenticateConnection,
  verifyConnection,

  // Connection queries
  getConnection,
  getConnectionByTenantAndName,
  getConnectionByRemoteConnectionId,
  getConnectionByLocalTenant,

  // Connection lifecycle
  dropConnection,
  refreshConnection,
  cleanupStaleConnections,
};
