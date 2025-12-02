/**
 * Connections Service
 * Manages server-to-server connections with cryptographic key exchange
 */

import { getDb } from "../db/db-connection";
import {
  connections,
  type ConnectionsInsert,
  type ConnectionsSelect,
  type TenantsSelect,
} from "../db/db-schema";
import { eq, and, lt, ne } from "drizzle-orm";
import log from "../log";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { generateJwt } from "../auth";
import { getLocalConnection } from "./init-local-connection";

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
 * Creates key pairs and exchanges public keys
 * If name is "local", updates the existing local connection instead of creating a new one
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

    // If name is "local", reuse the existing local connection
    let localPublicKey: string;
    let localPrivateKey: string;

    if (name === "local") {
      const localConnection = await getLocalConnection();
      if (!localConnection) {
        throw new Error(
          "Local connection not found. Please ensure server has been started at least once."
        );
      }
      localPublicKey = localConnection.localPublicKey;
      localPrivateKey = localConnection.localPrivateKey;
      log.info("Reusing existing local connection keys");
    } else {
      // Generate new key pair for non-local connections
      const keyPair = generateKeyPair();
      localPublicKey = keyPair.publicKey;
      localPrivateKey = keyPair.privateKey;
    }

    // Get remote server credentials
    const { token, tenants } = await validateRemoteCredentials(
      remoteUrl,
      remoteEmail,
      remotePassword
    );

    // Verify remote tenant exists
    const remoteTenant = tenants.find(
      (o: { tenantId: string; name: string; role: string }) =>
        o.tenantId === remoteTenantId
    );
    if (!remoteTenant) {
      throw new Error(`Remote tenant ${remoteTenantId} not found`);
    }

    // Create or update connection using upsert
    // Ensure all values are properly set (no undefined values)
    const newConnection: ConnectionsInsert = {
      tenantId: localTenantId,
      remoteUrl: remoteUrl || null,
      remoteTenantId: remoteTenantId || null,
      name: name,
      initiatedBy: "local",
      localPublicKey,
      localPrivateKey,
      localPrivateKeyType: "rsa-4096",
    };

    // Validate required fields
    if (!newConnection.tenantId) {
      throw new Error("tenantId is required");
    }
    if (!newConnection.localPublicKey) {
      throw new Error("localPublicKey is required");
    }
    if (!newConnection.localPrivateKey) {
      throw new Error("localPrivateKey is required");
    }
    if (!newConnection.remoteTenantId) {
      throw new Error("remoteTenantId is required");
    }

    // Validate that tenantId and remoteTenantId are different
    // if (newConnection.tenantId === newConnection.remoteTenantId) {
    //   throw new Error(
    //     `Cannot create connection: tenantId (${newConnection.tenantId}) and remoteTenantId (${newConnection.remoteTenantId}) cannot be the same`
    //   );
    // }

    let result;
    let connectionId: string;

    // If name is "local", update the existing connection instead of creating new one
    if (name === "local") {
      const localConnection = await getLocalConnection();
      if (!localConnection) {
        throw new Error(
          "Local connection not found. Please ensure server has been started at least once."
        );
      }

      // Update existing local connection with remote data
      // Set tenantId (local tenant) and remoteTenantId when connecting to a server
      const updateResult = await db
        .update(connections)
        .set({
          tenantId: localTenantId, // Set local tenant when connecting
          remoteUrl: newConnection.remoteUrl,
          remoteTenantId: newConnection.remoteTenantId,
          name: newConnection.name,
          initiatedBy: newConnection.initiatedBy,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, localConnection.id))
        .returning();

      if (!updateResult[0]) {
        throw new Error("Failed to update local connection");
      }

      result = updateResult;
      connectionId = localConnection.id;
      log.info(`Local connection updated: ${connectionId}`);
    } else {
      // Create new connection for non-local connections
      // Check if connection with same name already exists (name is unique)
      const existingByName = await db
        .select()
        .from(connections)
        .where(eq(connections.name, name))
        .limit(1);

      if (existingByName[0]) {
        // Connection with this name already exists, update it instead
        const updateResult = await db
          .update(connections)
          .set({
            tenantId: newConnection.tenantId,
            remoteUrl: newConnection.remoteUrl,
            remoteTenantId: newConnection.remoteTenantId,
            remotePublicKey: newConnection.remotePublicKey,
            remoteConnectionId: newConnection.remoteConnectionId,
            initiatedBy: newConnection.initiatedBy,
            localPublicKey: newConnection.localPublicKey,
            localPrivateKey: newConnection.localPrivateKey,
            localPrivateKeyType: newConnection.localPrivateKeyType,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(connections.id, existingByName[0].id))
          .returning();

        if (!updateResult[0]) {
          throw new Error("Failed to update connection by name");
        }

        result = updateResult;
        connectionId = existingByName[0].id;
        log.info(`Connection updated by name: ${connectionId}`);
      } else {
        // No connection with this name exists, try to insert
        try {
          result = await db
            .insert(connections)
            .values(newConnection)
            .onConflictDoUpdate({
              target: [
                connections.tenantId,
                connections.remoteTenantId,
                connections.name,
              ],
              set: {
                remotePublicKey: newConnection.remotePublicKey,
                remoteConnectionId: newConnection.remoteConnectionId,
                remoteUrl: newConnection.remoteUrl,
                name: newConnection.name,
                initiatedBy: newConnection.initiatedBy,
                localPublicKey: newConnection.localPublicKey,
                localPrivateKey: newConnection.localPrivateKey,
                localPrivateKeyType: newConnection.localPrivateKeyType,
              },
            })
            .returning();
        } catch (error: any) {
          log.error("Database insert error:", error + "");
          throw new Error(`Failed to insert connection: ${error?.message}`);
        }

        if (!result[0]) {
          throw new Error("Failed to create or update connection");
        }

        connectionId = result[0].id;
        log.info(`Connection upserted: ${connectionId}`);
      }

      // After creating/updating the named connection, also update the "local" connection
      // This represents the client side and should be updated with remote info
      try {
        const localConnection = await getLocalConnection();
        if (localConnection) {
          // Check if local connection already has remote info for this tenant combination
          const localHasRemoteInfo =
            localConnection.tenantId === localTenantId &&
            localConnection.remoteTenantId === remoteTenantId;

          if (!localHasRemoteInfo) {
            // Update local connection with remote info
            await db
              .update(connections)
              .set({
                tenantId: localTenantId,
                remoteUrl: remoteUrl,
                remoteTenantId: remoteTenantId,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(connections.id, localConnection.id));

            log.info(
              `Local connection updated with remote info: ${localConnection.id}`
            );
          } else {
            log.info(
              `Local connection already has remote info for this tenant combination, skipping update`
            );
          }
        }
      } catch (error) {
        log.error("Failed to update local connection:", error as object);
        // Don't throw - this is not critical for the main connection creation
      }
    }

    // Exchange public keys with remote server
    const localServerUrl = _GLOBAL_SERVER_CONFIG.baseUrl;

    try {
      const remotePublicKey = await exchangePublicKeys(
        remoteUrl,
        token,
        remoteTenantId,
        localTenantId,
        localPublicKey,
        connectionId,
        localServerUrl,
        name
      );

      // Update connection with remote public key
      await db
        .update(connections)
        .set({
          remotePublicKey,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, connectionId));

      return {
        connectionId,
        localPublicKey,
        remotePublicKey,
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
 * Creates a new connection on the remote side and returns public key
 * If a connection with the same tenant combination already exists, it will be replaced
 * Also updates the "local" connection with remote info if it exists
 */
export async function acceptConnection(
  localTenantId: string,
  remoteUrl: string,
  remoteTenantId: string,
  remoteConnectionId: string,
  remotePublicKey: string,
  connectionName: string
) {
  try {
    const db = getDb();

    // Generate local key pair for this side
    const { publicKey: localPublicKey, privateKey: localPrivateKey } =
      generateKeyPair();

    // Check if connection already exists for this tenant combination
    const existingConnection = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.tenantId, localTenantId),
          eq(connections.remoteTenantId, remoteTenantId)
        )
      );

    // Delete existing connection if found
    if (existingConnection[0]) {
      await db
        .delete(connections)
        .where(eq(connections.id, existingConnection[0].id));
      log.info(
        `Existing connection deleted and replaced: ${existingConnection[0].id}`
      );
    }

    // Create new connection on this side (initiated by remote = "server")
    const newConnection: ConnectionsInsert = {
      tenantId: localTenantId,
      remoteUrl,
      remoteTenantId: remoteTenantId,
      remoteConnectionId: remoteConnectionId,
      remotePublicKey: remotePublicKey,
      name: connectionName,
      initiatedBy: "remote",
      localPublicKey,
      localPrivateKey,
      localPrivateKeyType: "rsa-4096",
    };

    const result = await db
      .insert(connections)
      .values(newConnection)
      .returning();

    if (!result[0]) {
      throw new Error("Failed to create connection");
    }

    const connectionId = result[0].id;
    log.info(`Connection accepted and created: ${connectionId}`);

    // Update "local" connection with remote info
    // This represents the server itself and should be updated when a client connects
    // BUT: Only if no other connection with the same (tenantId, remoteTenantId, name="local") exists
    try {
      const localConnection = await getLocalConnection();
      if (localConnection) {
        // Check if there's already another connection with (tenantId, remoteTenantId, name="local")
        // excluding the local connection itself and the one we just created
        const existingLocalWithSameTenants = await db
          .select()
          .from(connections)
          .where(
            and(
              eq(connections.tenantId, localTenantId),
              eq(connections.remoteTenantId, remoteTenantId),
              eq(connections.name, "local"),
              ne(connections.id, localConnection.id), // Exclude the local connection itself
              ne(connections.id, connectionId) // Exclude the one we just created
            )
          );

        // Only update if no other "local" connection exists with this combination
        if (existingLocalWithSameTenants.length === 0) {
          await db
            .update(connections)
            .set({
              tenantId: localTenantId, // Set local tenant
              remoteUrl: remoteUrl, // Client URL
              remoteTenantId: remoteTenantId, // Client tenant
              remoteConnectionId: remoteConnectionId, // Client connection ID
              remotePublicKey: remotePublicKey, // Client public key
              updatedAt: new Date().toISOString(),
            })
            .where(eq(connections.id, localConnection.id));

          log.info(
            `Local connection updated with remote info: ${localConnection.id}`
          );
        } else {
          log.info(
            `Skipping local connection update - another "local" connection with same tenant combination already exists (ID: ${existingLocalWithSameTenants[0].id})`
          );
        }
      }
    } catch (error) {
      // Don't fail the connection if local update fails
      log.error("Failed to update local connection:", error as object);
    }

    return {
      connectionId,
      localPublicKey,
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
  localTenantId: string,
  localPublicKey: string,
  localConnectionId: string,
  localServerUrl: string,
  connectionName: string
) {
  try {
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
          remoteConnectionId: localConnectionId,
          remoteTenantId: localTenantId, // Local tenant ID (remote from the server's perspective)
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
    };

    if (!data.localPublicKey) {
      throw new Error("No public key received from remote");
    }

    return data.localPublicKey;
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
 * Get connection by tenant and remote tenant
 */
export async function getConnectionByTenants(
  tenantId: string,
  remoteTenantId: string
): Promise<ConnectionsSelect | null> {
  try {
    const db = getDb();

    const result = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.tenantId, tenantId),
          eq(connections.remoteTenantId, remoteTenantId)
        )
      );

    return result[0] ? result[0] : null;
  } catch (error) {
    log.error("Error getting connection:", error as object);
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
 * If connection name is "local", reset tenantId and remoteTenantId to null instead of deleting
 */
export async function dropConnection(connectionId: string) {
  try {
    const db = getDb();

    // Get connection to check if it's "local"
    const connection = await getConnection(connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    // If name is "local", reset tenantId and remoteTenantId to null instead of deleting
    if (connection.name === "local") {
      await db
        .update(connections)
        .set({
          tenantId: null, // Reset local tenant
          remoteUrl: null,
          remoteTenantId: null, // Reset remote tenant
          remoteConnectionId: null,
          remotePublicKey: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, connectionId));

      log.info(
        `Local connection reset (tenantId and remoteTenantId set to null): ${connectionId}`
      );
    } else {
      // Delete non-local connections
      await db.delete(connections).where(eq(connections.id, connectionId));
      log.info(`Connection dropped: ${connectionId}`);
    }
  } catch (error) {
    log.error("Error dropping connection:", error as object);
    throw error;
  }
}

/**
 * Authenticate a connection using signature
 */
export async function authenticateConnection(
  connectionId: string,
  timestamp: number,
  signature: string
) {
  try {
    // Check timestamp (prevent replay attacks, e.g. 5 mins window)
    const now = Date.now();
    if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
      throw new Error("Timestamp expired");
    }

    const connection = await getConnection(connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    if (!connection.remotePublicKey) {
      throw new Error("No remote public key found for connection");
    }

    const data = `${connectionId}:${timestamp}`;
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
      .where(eq(connections.id, connectionId));

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

    if (!connection.remoteConnectionId) {
      throw new Error("Remote connection ID not available");
    }

    if (!connection.remoteUrl) {
      throw new Error("Remote URL not available");
    }

    // Sign payload
    const timestamp = Date.now();
    // The data signed must match what the server expects: serverConnectionId:timestamp
    const data = `${connection.remoteConnectionId}:${timestamp}`;

    const signature = signData(data, connection.localPrivateKey);

    const response = await fetch(
      `${connection.remoteUrl}/api/v1/tenant/${connection.remoteTenantId}/connections/authenticate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connectionId: connection.remoteConnectionId,
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
 * Excludes "local" connections from cleanup
 */
export async function cleanupStaleConnections(days: number) {
  try {
    const db = getDb();
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - days);

    // Delete stale connections, but exclude "local" connections
    const result = await db
      .delete(connections)
      .where(
        and(
          lt(connections.lastConnectedAt, thresholdDate.toISOString()),
          ne(connections.name, "local")
        )
      )
      .returning();

    log.info(`Cleaned up ${result.length} stale connections (excluding local)`);
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
  getConnectionByTenants,
  getConnectionByLocalTenant,
  dropConnection,
  refreshConnection,
};
