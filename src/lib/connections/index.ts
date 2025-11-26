/**
 * Connections Service
 * Manages server-to-server connections with cryptographic key exchange
 */

import { getDb } from "../db/db-connection";
import {
  connections,
  type ConnectionsInsert,
  type ConnectionsSelect,
  TenantsSelect,
} from "../db/db-schema";
import { eq, and } from "drizzle-orm";
import log from "../log";
import { generateKeyPairSync } from "node:crypto";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

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

    const tenants = (await tenantsResponse.json()) as TenantsSelect[];

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

    // Generate local key pair
    const { publicKey: localPublicKey, privateKey: localPrivateKey } =
      generateKeyPair();

    // Get remote server credentials
    const { token, tenants } = await validateRemoteCredentials(
      remoteUrl,
      remoteEmail,
      remotePassword
    );

    // Verify remote tenant exists
    const remoteTenant = tenants.find(
      (o: TenantsSelect) => o.id === remoteTenantId
    );
    if (!remoteTenant) {
      throw new Error(`Remote tenant ${remoteTenantId} not found`);
    }

    // Check if connection already exists
    const existingConnection = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.tenantId, localTenantId),
          eq(connections.remoteTenantId, remoteTenantId)
        )
      );

    let connectionId: string;

    if (existingConnection.length > 0) {
      // Update existing connection
      connectionId = existingConnection[0].id;
      await db
        .update(connections)
        .set({
          remoteUrl,
          name,
          initiatedBy: "client",
          localPublicKey,
          localPrivateKey,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, connectionId));

      log.info(`Connection updated: ${connectionId}`);
    } else {
      // Create new connection
      const newConnection: ConnectionsInsert = {
        tenantId: localTenantId,
        remoteUrl,
        remoteTenantId: remoteTenantId,
        name,
        initiatedBy: "client",
        localPublicKey,
        localPrivateKey,
        localPrivateKeyType: "rsa-4096",
      };

      const result = await db
        .insert(connections)
        .values(newConnection)
        .returning();

      connectionId = result[0].id;
      log.info(`Connection created: ${connectionId}`);
    }

    // Exchange public keys with remote server
    const localServerUrl = _GLOBAL_SERVER_CONFIG.baseUrl;

    try {
      const remotePublicKey = await exchangePublicKeys(
        remoteUrl,
        token,
        remoteTenantId,
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
    } catch (exchangeError) {
      // If key exchange fails and we just created a new connection, delete it
      if (existingConnection.length === 0) {
        await db.delete(connections).where(eq(connections.id, connectionId));
        log.info(
          `Connection rolled back due to key exchange failure: ${connectionId}`
        );
      }
      throw exchangeError;
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
    if (existingConnection.length > 0) {
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
      initiatedBy: "server",
      localPublicKey,
      localPrivateKey,
      localPrivateKeyType: "rsa-4096",
    };

    const result = await db
      .insert(connections)
      .values(newConnection)
      .returning();

    const connectionId = result[0].id;
    log.info(`Connection accepted and created: ${connectionId}`);

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
          remoteTenantId: remoteTenantId,
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

    return result.length > 0 ? result[0] : null;
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

    return result.length > 0 ? result[0] : null;
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
 */
export async function dropConnection(connectionId: string) {
  try {
    const db = getDb();

    // Delete connection
    await db.delete(connections).where(eq(connections.id, connectionId));

    log.info(`Connection dropped: ${connectionId}`);
  } catch (error) {
    log.error("Error dropping connection:", error as object);
    throw error;
  }
}

/**
 * Export service as singleton
 */
export const connectionsService = {
  generateKeyPair,
  validateRemoteCredentials,
  initializeConnection,
  acceptConnection,
  getConnection,
  getConnectionByTenants,
  getConnectionByLocalTenant,
  dropConnection,
};
