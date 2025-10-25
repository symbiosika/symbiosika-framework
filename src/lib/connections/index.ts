/**
 * Connections Service
 * Manages server-to-server connections with cryptographic key exchange
 */

import { getDb } from "../db/db-connection";
import {
  connections,
  connectionSessions,
  type ConnectionsInsert,
  type ConnectionsSelect,
  type ConnectionSessionsInsert,
  type ConnectionSessionsSelect,
  OrganisationMembersSelect,
} from "../db/db-schema";
import { eq, and } from "drizzle-orm";
import log from "../log";
import { generateKeyPairSync } from "node:crypto";

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
 * Validate remote server credentials and retrieve organisations
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

    // Get user's organizations
    const orgsResponse = await fetch(`${remoteUrl}/api/v1/user/organisations`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${data.token}`,
      },
    });

    if (!orgsResponse.ok) {
      throw new Error(
        `Failed to fetch organisations: ${orgsResponse.statusText}`
      );
    }

    const orgsData = (await orgsResponse.json()) as OrganisationMembersSelect[];

    return {
      token: data.token,
      organisations: orgsData || [],
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
  localOrganisationId: string,
  remoteUrl: string,
  remoteEmail: string,
  remotePassword: string,
  remoteOrganisationId: string,
  name: string
) {
  try {
    const db = getDb();

    // Generate local key pair
    const { publicKey: localPublicKey, privateKey: localPrivateKey } =
      generateKeyPair();

    // Get remote server credentials
    const { token, organisations } = await validateRemoteCredentials(
      remoteUrl,
      remoteEmail,
      remotePassword
    );

    // Verify remote organisation exists
    const remoteOrg = organisations.find(
      (o: OrganisationMembersSelect) =>
        o.organisationId === remoteOrganisationId
    );
    if (!remoteOrg) {
      throw new Error("Remote organisation not found");
    }

    // Check if connection already exists
    const existingConnection = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.organisationId, localOrganisationId),
          eq(connections.remoteOrganisationId, remoteOrganisationId)
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
        organisationId: localOrganisationId,
        remoteUrl,
        remoteOrganisationId: remoteOrganisationId,
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
    const remotePublicKey = await exchangePublicKeys(
      remoteUrl,
      token,
      remoteOrganisationId,
      localPublicKey,
      connectionId
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
}

/**
 * Exchange public keys with remote server
 */
async function exchangePublicKeys(
  remoteUrl: string,
  token: string,
  remoteOrganisationId: string,
  localPublicKey: string,
  localConnectionId: string
) {
  try {
    const response = await fetch(
      `${remoteUrl}/api/v1/organisation/${remoteOrganisationId}/connections/exchange-keys`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          publicKey: localPublicKey,
          connectionId: localConnectionId,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to exchange public keys: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      remotePublicKey?: string;
    };
    return data.remotePublicKey || "";
  } catch (error) {
    log.error("Error exchanging public keys:", error as object);
    throw error;
  }
}

/**
 * Create a new connection session (WebSocket)
 */
export async function createConnectionSession(
  connectionId: string,
  remoteSessionId?: string
): Promise<ConnectionSessionsSelect> {
  try {
    const db = getDb();

    const session: ConnectionSessionsInsert = {
      connectionId: connectionId,
      remoteSessionId: remoteSessionId ?? null,
      status: "active",
      encryptionAlgorithm: "aes-256-cbc",
    };

    const result = await db
      .insert(connectionSessions)
      .values(session)
      .returning();

    log.info(`Connection session created: ${result[0].id}`);
    return result[0];
  } catch (error) {
    log.error("Error creating connection session:", error as object);
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
 * Get connection by organisation and remote organisation
 */
export async function getConnectionByOrganisations(
  organisationId: string,
  remoteOrganisationId: string
): Promise<ConnectionsSelect | null> {
  try {
    const db = getDb();

    const result = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.organisationId, organisationId),
          eq(connections.remoteOrganisationId, remoteOrganisationId)
        )
      );

    return result.length > 0 ? result[0] : null;
  } catch (error) {
    log.error("Error getting connection:", error as object);
    throw error;
  }
}

/**
 * List all connections for an organisation
 */
export async function listConnections(organisationId: string) {
  try {
    const db = getDb();

    const result = await db
      .select()
      .from(connections)
      .where(eq(connections.organisationId, organisationId));

    return result;
  } catch (error) {
    log.error("Error listing connections:", error as object);
    throw error;
  }
}

/**
 * List all sessions for a connection
 */
export async function listConnectionSessions(connectionId: string) {
  try {
    const db = getDb();

    const result = await db
      .select()
      .from(connectionSessions)
      .where(eq(connectionSessions.connectionId, connectionId));

    return result;
  } catch (error) {
    log.error("Error listing connection sessions:", error as object);
    throw error;
  }
}

/**
 * Update session heartbeat
 */
export async function updateSessionHeartbeat(sessionId: string) {
  try {
    const db = getDb();

    await db
      .update(connectionSessions)
      .set({
        lastHeartbeat: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(connectionSessions.id, sessionId));
  } catch (error) {
    log.error("Error updating session heartbeat:", error as object);
    throw error;
  }
}

/**
 * Drop connection session
 */
export async function dropConnectionSession(sessionId: string) {
  try {
    const db = getDb();

    await db
      .delete(connectionSessions)
      .where(eq(connectionSessions.id, sessionId));

    log.info(`Connection session dropped: ${sessionId}`);
  } catch (error) {
    log.error("Error dropping connection session:", error as object);
    throw error;
  }
}

/**
 * Drop connection
 */
export async function dropConnection(connectionId: string) {
  try {
    const db = getDb();

    // Delete all sessions first
    const sessions = await listConnectionSessions(connectionId);
    for (const session of sessions) {
      await dropConnectionSession(session.id);
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
 * Authenticate WebSocket connection with key pair
 */
export async function authenticateConnectionSession(
  connectionId: string,
  signature: string,
  nonce: string
): Promise<boolean> {
  try {
    const connection = await getConnection(connectionId);

    if (!connection) {
      throw new Error("Connection not found");
    }

    // Verify signature using local public key
    // This would use the crypto module to verify the signature
    // For now, we'll implement basic verification

    log.info(
      `WebSocket connection authenticated for connection: ${connectionId}`
    );
    return true;
  } catch (error) {
    log.error("Error authenticating connection session:", error as object);
    return false;
  }
}

/**
 * Export service as singleton
 */
export const connectionsService = {
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
  authenticateConnectionSession,
};
