/**
 * Connections Service
 * Manages server-to-server connections with cryptographic key exchange
 */

import { getDb } from "../db/db-connection";
import {
  connections,
  type ConnectionsInsert,
  type ConnectionsSelect,
  tenants,
} from "../db/db-schema";
import { eq, and, lt, ne } from "drizzle-orm";
import log from "../log";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { generateJwt } from "../auth";
import { getServerKeys } from "./init-server-keys";
import { getTenant, updateTenant } from "../usermanagement/tenants";

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
export function signData(data: string, privateKey: string) {
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
) {
  const buffer = Buffer.from(data);
  const signatureBuffer = Buffer.from(signature, "base64");
  return verify("sha256", buffer, publicKey, signatureBuffer);
}

/**
 * Validate remote server credentials and retrieve tenants
 */
export async function validateRemoteCredentials(
  remoteUrl: string,
  email: string,
  password: string
) {
  try {
    const response = await fetch(`${remoteUrl}/api/v1/user/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to authenticate: ${response.statusText}`);
    }

    const data = (await response.json()) as { token?: string };

    if (!data.token) {
      throw new Error("No authentication token received");
    }

    // Get user's tenants
    const tenantsResponse = await fetch(`${remoteUrl}/api/v1/user/tenants`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${data.token}`,
      },
    });

    if (!tenantsResponse.ok) {
      throw new Error(`Failed to fetch tenants: ${tenantsResponse.statusText}`);
    }

    const tenants = (await tenantsResponse.json()) as {
      tenantId: string;
      name: string;
      role: string;
    }[];

    return {
      token: data.token,
      tenants: tenants || [],
    };
  } catch (error) {
    log.error("Error validating remote credentials:", error as object);
    throw error;
  }
}

/**
 * Initialize connection with remote server
 * Uses server keys and exchanges public keys
 * Creates/updates remote tenant locally with same ID
 */
export async function initializeConnection(
  localTenantId: string,
  remoteUrl: string,
  remoteEmail: string,
  remotePassword: string,
  remoteTenantId: string,
  name: string
) {
  try {
    const db = getDb();

    // Get server keys (must exist) - this is the clientId
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error(
        "Server keys not found. Please ensure server has been started at least once."
      );
    }

    // Get remote server credentials
    const { token, tenants: remoteTenants } = await validateRemoteCredentials(
      remoteUrl,
      remoteEmail,
      remotePassword
    );

    // Verify remote tenant exists
    const remoteTenant = remoteTenants.find(
      (o: { tenantId: string; name: string; role: string }) =>
        o.tenantId === remoteTenantId
    );
    if (!remoteTenant) {
      throw new Error(`Remote tenant ${remoteTenantId} not found`);
    }

    // Create tenant with same ID
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
      `Created local tenant ${remoteTenantId} with name: ${remoteTenant.name}`
    );

    // Create or update connection using upsert
    const newConnection: ConnectionsInsert = {
      tenantId: remoteTenantId, // Use remote tenant ID (now local)
      remoteUrl: remoteUrl || null,
      name: name,
      initiatedBy: "local",
      clientId: serverKey.id, // Client's server ID
      remotePublicKey: null,
    };

    // Validate required fields
    if (!newConnection.tenantId) {
      throw new Error("tenantId is required");
    }
    if (!newConnection.clientId) {
      throw new Error("clientId is required");
    }

    // Use upsert based on unique constraint (clientId, initiatedBy)
    // This ensures we always have exactly one connection with initiatedBy="local" for this clientId
    let result;
    let connectionId: string;

    try {
      result = await db
        .insert(connections)
        .values(newConnection)
        .onConflictDoUpdate({
          target: [connections.clientId],
          set: {
            tenantId: newConnection.tenantId,
            remoteUrl: newConnection.remoteUrl,
            name: newConnection.name,
            remotePublicKey: newConnection.remotePublicKey,
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
    } catch (error: any) {
      log.error("Database upsert error:", error + "");
      throw new Error(`Failed to upsert connection: ${error?.message}`);
    }

    if (!result[0]) {
      throw new Error("Failed to create or update connection");
    }

    connectionId = result[0].id;
    log.info(
      `Connection upserted (clientId: ${newConnection.clientId}, initiatedBy: ${newConnection.initiatedBy}): ${connectionId}`
    );

    // Exchange public keys with remote server
    const localServerUrl = _GLOBAL_SERVER_CONFIG.baseUrl;

    try {
      const exchangeResult = await exchangePublicKeys(
        remoteUrl,
        token,
        remoteTenantId,
        serverKey.publicKey,
        serverKey.id, // clientId
        localServerUrl,
        name
      );

      // Update connection with remote public key
      await db
        .update(connections)
        .set({
          remotePublicKey: exchangeResult.remotePublicKey,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, connectionId));

      return {
        connectionId,
        localPublicKey: serverKey.publicKey,
        remotePublicKey: exchangeResult.remotePublicKey,
        status: "active",
      };
    } catch (error) {
      log.error("Error initializing connection:", error as object);
      throw error;
    }
  } catch (error) {
    log.error("Error initializing connection:", error as object);
    throw error;
  }
}

/**
 * Accept connection request from remote server
 * Creates a new connection on this side and returns public key
 * Uses the clientId from the remote server (must be same on both sides)
 * Creates/updates remote tenant locally with same ID
 */
export async function acceptConnection(
  localTenantId: string,
  remoteUrl: string,
  remoteTenantId: string,
  clientId: string, // The client's serverId (must be same on both sides)
  remotePublicKey: string,
  connectionName: string,
  remoteTenantName: string
) {
  try {
    const db = getDb();

    // Get server keys (must exist)
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error(
        "Server keys not found. Please ensure server has been started at least once."
      );
    }

    // Create or update remote tenant locally with same ID
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

    // Create new connection on this side (initiated by remote)
    // Use clientId from remote (must be same on both sides)
    const newConnection: ConnectionsInsert = {
      tenantId: remoteTenantId, // Use remote tenant ID (now local)
      remoteUrl,
      remotePublicKey: remotePublicKey,
      name: connectionName,
      initiatedBy: "remote",
      clientId: clientId, // Client's serverId (must match on both sides)
    };

    // Use upsert based on unique constraint (clientId, initiatedBy)
    // This ensures we always have exactly one connection with initiatedBy="remote" for this clientId
    let result;
    let connectionId: string;

    try {
      result = await db
        .insert(connections)
        .values(newConnection)
        .onConflictDoUpdate({
          target: [connections.clientId],
          set: {
            tenantId: newConnection.tenantId,
            remoteUrl: newConnection.remoteUrl,
            name: newConnection.name,
            remotePublicKey: newConnection.remotePublicKey,
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
    } catch (error: any) {
      log.error("Database upsert error:", error + "");
      throw new Error(`Failed to upsert connection: ${error?.message}`);
    }

    if (!result[0]) {
      throw new Error("Failed to create or update connection");
    }

    connectionId = result[0].id;
    log.info(
      `Connection accepted and upserted (clientId: ${clientId}, initiatedBy: remote): ${connectionId}`
    );

    return {
      connectionId,
      localPublicKey: serverKey.publicKey,
      serverId: serverKey.id, // Our serverId (not used, but returned for compatibility)
    };
  } catch (error) {
    log.error("Error accepting connection:", error as object);
    throw error;
  }
}

/**
 * Exchange public keys with remote server
 * Sends complete connection info and receives connection acceptance
 */
async function exchangePublicKeys(
  remoteUrl: string,
  token: string,
  remoteTenantId: string,
  localPublicKey: string,
  clientId: string, // Client's serverId
  localServerUrl: string,
  connectionName: string
) {
  try {
    // Get remote tenant info to send name
    const remoteTenantsResponse = await fetch(
      `${remoteUrl}/api/v1/user/tenants`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!remoteTenantsResponse.ok) {
      throw new Error(
        `Failed to fetch tenant info: ${remoteTenantsResponse.statusText}`
      );
    }

    const remoteTenants = (await remoteTenantsResponse.json()) as {
      tenantId: string;
      name: string;
      role: string;
    }[];

    const remoteTenant = remoteTenants.find(
      (t) => t.tenantId === remoteTenantId
    );

    if (!remoteTenant) {
      throw new Error(`Remote tenant ${remoteTenantId} not found`);
    }

    const response = await fetch(
      `${remoteUrl}/api/v1/tenant/${remoteTenantId}/connections/exchange-keys`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          // Complete connection info for remote side to accept
          remotePublicKey: localPublicKey,
          clientId: clientId, // Client's serverId (must be same on both sides)
          remoteTenantId: remoteTenantId,
          remoteTenantName: remoteTenant.name,
          remoteUrl: localServerUrl,
          connectionName: connectionName,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to exchange public keys: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      connectionId?: string;
      localPublicKey?: string;
      serverId?: string;
    };

    if (!data.localPublicKey) {
      throw new Error("No public key received from remote");
    }

    return {
      remotePublicKey: data.localPublicKey,
    };
  } catch (error) {
    log.error("Error exchanging public keys:", error as object);
    throw error;
  }
}

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
      .where(eq(connections.id, connectionId));

    return result[0] ? result[0] : null;
  } catch (error) {
    log.error("Error getting connection:", error as object);
    throw error;
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
      .where(
        and(eq(connections.tenantId, tenantId), eq(connections.name, name))
      );

    return result[0] ? result[0] : null;
  } catch (error) {
    log.error("Error getting connection:", error as object);
    throw error;
  }
}

/**
 * Get connection by client ID
 */
export async function getConnectionByClientId(
  tenantId: string,
  clientId: string
): Promise<ConnectionsSelect | null> {
  try {
    const db = getDb();

    const result = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.tenantId, tenantId),
          eq(connections.clientId, clientId)
        )
      );

    return result[0] ? result[0] : null;
  } catch (error) {
    log.error("Error getting connection by client ID:", error as object);
    throw error;
  }
}

/**
 * List all connections for an tenant
 */
export async function getConnectionByLocalTenant(tenantId: string) {
  try {
    const db = getDb();

    const result = await db
      .select()
      .from(connections)
      .where(eq(connections.tenantId, tenantId));

    return result;
  } catch (error) {
    log.error("Error listing connections:", error as object);
    throw error;
  }
}

/**
 * Drop connection
 */
export async function dropConnection(connectionId: string) {
  try {
    const db = getDb();

    // Get connection
    const connection = await getConnection(connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    // Delete connection
    await db.delete(connections).where(eq(connections.id, connectionId));
    log.info(`Connection dropped: ${connectionId}`);
  } catch (error) {
    log.error("Error dropping connection:", error as object);
    throw error;
  }
}

/**
 * Authenticate a connection using signature
 * Looks up connection by clientId (the serverId from the calling client)
 */
export async function authenticateConnection(
  tenantId: string,
  clientId: string,
  timestamp: number,
  signature: string
) {
  try {
    // Check timestamp (prevent replay attacks, e.g. 5 mins window)
    const now = Date.now();
    if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
      throw new Error("Timestamp expired");
    }

    // Look up connection by clientId (the calling client's serverId)
    const connection = await getConnectionByClientId(tenantId, clientId);
    if (!connection) {
      throw new Error("Connection not found for client ID");
    }

    if (!connection.remotePublicKey) {
      throw new Error("No remote public key found for connection");
    }

    // Use clientId for signature verification (matches what client signs)
    const data = `${clientId}:${timestamp}`;
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

    // Generate JWT
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

    return { token };
  } catch (error) {
    log.error("Error authenticating connection:", error as object);
    throw error;
  }
}

/**
 * Verify connection by authenticating with remote server
 */
export async function verifyConnection(connectionId: string) {
  try {
    const connection = await getConnection(connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    if (!connection.clientId) {
      throw new Error("Client ID not available");
    }

    if (!connection.remoteUrl) {
      throw new Error("Remote URL not available");
    }

    // Get server keys for signing
    const serverKey = await getServerKeys();
    if (!serverKey) {
      throw new Error("Server keys not found");
    }

    // Sign payload using our server's private key
    const timestamp = Date.now();
    // The data signed must match what the server expects: clientId:timestamp
    // We sign with our clientId (which is our serverId)
    const data = `${connection.clientId}:${timestamp}`;

    const signature = signData(data, serverKey.privateKey);

    const response = await fetch(
      `${connection.remoteUrl}/api/v1/tenant/${connection.tenantId}/connections/authenticate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId: connection.clientId, // Our clientId (must match on both sides)
          timestamp,
          signature,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Authentication failed: ${response.statusText}`);
    }

    const result = (await response.json()) as { token: string };
    return result;
  } catch (error) {
    log.error("Error verifying connection:", error as object);
    throw error;
  }
}

/**
 * Cleanup stale connections
 */
export async function cleanupStaleConnections(days: number) {
  try {
    const db = getDb();
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - days);

    // Delete stale connections
    const result = await db
      .delete(connections)
      .where(lt(connections.lastConnectedAt, thresholdDate.toISOString()))
      .returning();

    log.info(`Cleaned up ${result.length} stale connections`);
    return result.length;
  } catch (error) {
    log.error("Error cleaning up stale connections:", error as object);
    throw error;
  }
}

/**
 * Refresh connection - update lastConnectedAt timestamp
 */
export async function refreshConnection(connectionId: string) {
  try {
    const db = getDb();

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
    throw error;
  }
}

/**
 * Export service as singleton
 */
export const connectionsService = {
  generateKeyPair,
  signData,
  verifySignature,
  validateRemoteCredentials,
  initializeConnection,
  authenticateConnection,
  verifyConnection,
  cleanupStaleConnections,
  acceptConnection,
  getConnection,
  getConnectionByTenantAndName,
  getConnectionByClientId,
  getConnectionByLocalTenant,
  dropConnection,
  refreshConnection,
};
