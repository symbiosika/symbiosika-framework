/**
 * Initialize server keys on server startup
 * Ensures exactly ONE entry exists in server_keys table
 * This represents the server's identity for all connections
 */

import { getDb } from "../db/db-connection";
import { serverKeys, type ServerKeysInsert } from "../db/db-schema";
import { eq } from "drizzle-orm";
import log from "../log";
import { generateKeyPair } from "./index";

/**
 * Get server keys (there should be exactly one)
 */
export async function getServerKeys() {
  try {
    const db = getDb();

    const result = await db.select().from(serverKeys).limit(2);

    if (result.length === 0) {
      return null;
    }

    if (result.length > 1) {
      throw new Error(
        `Multiple server keys found (${result.length}). There should be exactly one.`
      );
    }

    return result[0];
  } catch (error) {
    log.error("Error getting server keys:", error as object);
    throw error;
  }
}

/**
 * Initialize server keys if they don't exist
 * This should be called on server startup
 * Ensures exactly ONE entry exists
 */
export async function initServerKeysIfNeeded() {
  try {
    const db = getDb();

    // Check if server keys already exist
    const existing = await getServerKeys();

    if (existing) {
      log.info("Server keys already exist, skipping initialization");
      return existing;
    }

    // Generate key pair for server
    const { publicKey, privateKey } = generateKeyPair();

    // Create server keys entry
    const serverKeysEntry: ServerKeysInsert = {
      privateKey,
      publicKey,
    };

    try {
      const result = await db
        .insert(serverKeys)
        .values(serverKeysEntry)
        .returning();

      if (!result[0]) {
        throw new Error("Failed to create server keys");
      }

      log.info(`Server keys initialized: ${result[0].id}`);
      return result[0];
    } catch (error: any) {
      // If unique constraint violation or race condition, check again
      if (error?.code === "23505" || error?.code === "23514") {
        log.info("Server keys already exist (race condition), checking again");
        const existing = await getServerKeys();
        if (!existing) {
          throw new Error("Failed to create server keys after race condition");
        }
        return existing;
      } else {
        log.error("Error creating server keys:", error as object);
        throw error;
      }
    }
  } catch (error) {
    log.error("Error initializing server keys:", error as object);
    throw error;
  }
}

