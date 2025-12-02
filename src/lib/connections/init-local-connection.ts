/**
 * Initialize local connection on server startup
 * Creates a single "local" connection entry if it doesn't exist
 * This connection represents the server itself and is required
 * tenantId is null initially and will be updated when connecting to a remote server
 */

import { getDb } from "../db/db-connection";
import { connections, type ConnectionsInsert } from "../db/db-schema";
import { eq } from "drizzle-orm";
import log from "../log";
import { generateKeyPair } from "./index";

const LOCAL_CONNECTION_NAME = "local";

/**
 * Get local connection by name
 * There is only one "local" connection globally
 */
export async function getLocalConnection() {
  try {
    const db = getDb();

    const result = await db
      .select()
      .from(connections)
      .where(eq(connections.name, LOCAL_CONNECTION_NAME))
      .limit(1);

    return result[0] || null;
  } catch (error) {
    log.error("Error getting local connection:", error as object);
    throw error;
  }
}

/**
 * Initialize local connection if it doesn't exist
 * This should be called on server startup
 * tenantId is null initially and will be updated when connecting to a remote server
 */
export async function initLocalConnectionIfNeeded() {
  try {
    const db = getDb();

    // Check if local connection already exists
    const existing = await getLocalConnection();

    if (existing) {
      log.info("Local connection already exists, skipping initialization");
      return existing;
    }

    // Generate key pair for local connection
    const { publicKey: localPublicKey, privateKey: localPrivateKey } =
      generateKeyPair();

    // Create local connection
    // tenantId is null initially - will be updated when connecting to a remote server
    const localConnection: ConnectionsInsert = {
      name: LOCAL_CONNECTION_NAME,
      tenantId: null as any, // Will be set when connecting to a remote server
      remoteUrl: null,
      remoteTenantId: null,
      remoteConnectionId: null,
      remotePublicKey: null,
      initiatedBy: "local",
      localPublicKey,
      localPrivateKey,
      localPrivateKeyType: "rsa-4096",
    };

    try {
      const result = await db
        .insert(connections)
        .values(localConnection)
        .returning();

      if (!result[0]) {
        throw new Error("Failed to create local connection");
      }

      log.info(`Local connection initialized: ${result[0].id}`);
      return result[0];
    } catch (error: any) {
      // If unique constraint violation, connection already exists (race condition)
      if (error?.code === "23505") {
        log.info("Local connection already exists (race condition), skipping");
        const existing = await getLocalConnection();
        return existing;
      } else {
        log.error("Error creating local connection:", error as object);
        throw error;
      }
    }
  } catch (error) {
    log.error("Error initializing local connection:", error as object);
    throw error;
  }
}
