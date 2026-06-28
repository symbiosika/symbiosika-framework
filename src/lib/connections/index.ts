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
import {
  getTenant,
  deleteTenant,
  addTenantMember,
  setLastTenant,
} from "../usermanagement/tenants";
import { runPostConnectionActions } from "./actions";

export type ConnectionRole = "leading" | "following";

/**
 * Options for the *initiating* (client) side of a connection.
 * - role: this side's role. Defaults to "following" — the requester normally
 *   mirrors the remote main server. Set "leading" for the reverse case.
 * - replaceLocalTenants: when following, wipe all other local tenants after a
 *   successful handshake so this instance becomes a pure mirror of the leader
 *   tenant (edge/appliance mode). DESTRUCTIVE — off by default.
 * - actingUserId: the admin performing the action; kept as owner of the
 *   adopted leader tenant so the login survives the switch.
 */
export interface ConnectionInitOptions {
  role?: ConnectionRole;
  replaceLocalTenants?: boolean;
  actingUserId?: string;
}

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

export interface DisconnectResult {
  connectionId: string;
  /** Whether the remote side acknowledged the teardown (deleted its row). */
  remoteNotified: boolean;
}

/**
 * Thrown by authenticateConnection when no connection exists for the given
 * remoteConnectionId. The remote side translates this into an explicit
 * `connection_not_found` response so the caller can self-heal (scenario 2:
 * the other side already terminated the connection while we were offline).
 */
export class ConnectionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionNotFoundError";
  }
}

/**
 * Thrown by verifyConnection when the remote side explicitly reported that the
 * connection no longer exists. The local connection has been removed at this
 * point — callers should treat the connection as gone (e.g. re-onboard).
 */
export class ConnectionGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionGoneError";
  }
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
  localTenantName: string,
  peerRole: ConnectionRole
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
        // The role the *receiving* side should take (opposite of ours).
        role: peerRole,
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

function oppositeRole(role: ConnectionRole): ConnectionRole {
  return role === "leading" ? "following" : "leading";
}

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * True when `remoteUrl` points at this very server (its configured baseUrl).
 *
 * A connection models two *separate* databases: the initiating side stores a
 * shadow of the leader tenant and one connection row; the accepting side stores
 * the mirror row. Pointed at itself, a single database would hold both rows
 * under the same tenant id (ambiguous `getConnectionByRemoteConnectionId`
 * lookups) and the shadow upsert would overwrite a real local tenant's origin.
 * It is therefore not a sound operation and is rejected explicitly.
 */
export function isSelfConnectionUrl(remoteUrl: string): boolean {
  const base = _GLOBAL_SERVER_CONFIG.baseUrl;
  if (!base || !remoteUrl) return false;
  return normalizeServerUrl(base) === normalizeServerUrl(remoteUrl);
}


/**
 * Create or refresh the local mirror ("shadow") of a remote *leader* tenant.
 * Marked origin="remote" so it is exempt from local name-uniqueness and can
 * coexist with same-named local or remote tenants. Returns whether the row was
 * newly created, so a failed handshake can roll it back without touching a
 * pre-existing tenant.
 */
async function upsertRemoteShadowTenant(
  remoteTenantId: string,
  remoteTenantName: string
): Promise<{ created: boolean }> {
  const db = getDb();
  const existing = await getTenant(remoteTenantId);
  await db
    .insert(tenants)
    .values({ id: remoteTenantId, name: remoteTenantName, origin: "remote" })
    .onConflictDoUpdate({
      target: [tenants.id],
      set: {
        name: remoteTenantName,
        origin: "remote",
        updatedAt: new Date().toISOString(),
      },
    });
  return { created: !existing };
}

/**
 * Delete every local tenant except the one to keep. DESTRUCTIVE: tenant
 * deletion cascades to teams, members, permissions, app data and any other
 * connections. Only ever invoked on a following side that explicitly opted in
 * via `replaceLocalTenants`, and only after the handshake fully succeeded.
 */
async function deleteAllTenantsExcept(keepTenantId: string): Promise<number> {
  const db = getDb();
  const all = await db.select({ id: tenants.id }).from(tenants);
  let deleted = 0;
  for (const t of all) {
    if (t.id === keepTenantId) continue;
    await deleteTenant(t.id);
    deleted++;
  }
  log.info(
    `Edge cleanup: removed ${deleted} local tenant(s), kept ${keepTenantId}`
  );
  return deleted;
}

/**
 * Ensure the initiating admin keeps a working login on the adopted leader
 * tenant (which starts out with no local members): add them as owner and point
 * their lastTenant at it.
 */
async function ensureOwnerOfAdoptedTenant(
  tenantId: string,
  actingUserId: string
): Promise<void> {
  await addTenantMember(tenantId, actingUserId, "owner");
  // setLastTenant verifies membership, which we just created.
  await setLastTenant(actingUserId, tenantId).catch((err) =>
    log.error("Failed to set lastTenant after adoption:", err as object)
  );
}

/**
 * Initialize connection with remote server (initiating / client side).
 *
 * Flow:
 * 1. Validate remote credentials and locate the target remote tenant.
 * 2. Decide this side's role (default "following").
 * 3. If following: adopt the remote (leader) tenant locally as a shadow
 *    (origin="remote"). If leading: no shadow is created.
 * 4. Create the connection record in status "pending".
 * 5. Exchange public keys; the peer is told to take the opposite role.
 * 6. On success: flip to "active". If following, keep the acting admin as owner
 *    of the adopted tenant and — when replaceLocalTenants is set — wipe all
 *    other local tenants so this instance becomes a pure mirror.
 *
 * @param localTenantId - The tenant context initiating the connection
 * @param remoteUrl - URL of the remote server
 * @param remoteEmail - Email for remote authentication
 * @param remotePassword - Password for remote authentication
 * @param remoteTenantId - Tenant ID on remote server
 * @param name - Name for the connection
 * @param options - Role / edge-mode / acting-user options
 */
export async function initializeConnection(
  localTenantId: string,
  remoteUrl: string,
  remoteEmail: string,
  remotePassword: string,
  remoteTenantId: string,
  name: string,
  options: ConnectionInitOptions = {}
): Promise<ConnectionInitResult> {
  const db = getDb();
  const role: ConnectionRole = options.role ?? "following";

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

    return await runInitiatingHandshake({
      role,
      remoteUrl,
      remoteToken: token,
      remoteTenantId,
      remoteTenantName: remoteTenant.name,
      name,
      localTenantId,
      localTenantName: localTenant.name,
      serverPublicKey: serverKey.publicKey,
      options,
    });
  } catch (error) {
    log.error("Error initializing connection:", error as object);
    throw error instanceof Error
      ? error
      : new Error("Failed to initialize connection");
  }
}

/**
 * Shared core of the initiating side, used by both the password-based
 * (`initializeConnection`) and the OTP-token-based
 * (`initializeConnectionWithToken`) flows. Handles role-aware shadow creation,
 * staged (pending) connection setup, key exchange, and post-success adoption.
 */
async function runInitiatingHandshake(args: {
  role: ConnectionRole;
  remoteUrl: string;
  remoteToken: string;
  remoteTenantId: string;
  remoteTenantName: string;
  name: string;
  localTenantId: string;
  localTenantName: string;
  serverPublicKey: string;
  options: ConnectionInitOptions;
}): Promise<ConnectionInitResult> {
  const db = getDb();
  const {
    role,
    remoteUrl,
    remoteToken,
    remoteTenantId,
    remoteTenantName,
    name,
    localTenantId,
    localTenantName,
    serverPublicKey,
    options,
  } = args;

  const following = role === "following";

  // A server cannot meaningfully connect to itself (see isSelfConnectionUrl).
  if (isSelfConnectionUrl(remoteUrl)) {
    throw new Error(
      "Refusing to connect a server to itself: remoteUrl points to this server's own baseUrl."
    );
  }

  // A following side mirrors the leader tenant locally and runs the connection
  // under it; a leading side keeps its own tenant and never shadows the remote.
  let shadowCreated = false;
  if (following) {
    const res = await upsertRemoteShadowTenant(remoteTenantId, remoteTenantName);
    shadowCreated = res.created;
    log.info(
      `Adopted leader tenant ${remoteTenantId} locally (origin=remote, created=${shadowCreated})`
    );
  }
  const ownerTenantId = following ? remoteTenantId : localTenantId;

  // Shared id between both sides.
  const remoteConnectionId = randomUUID();

  const newConnection: ConnectionsInsert = {
    tenantId: ownerTenantId,
    remoteUrl,
    name,
    initiatedBy: "local",
    role,
    status: "pending",
    remoteTenantId,
    remoteConnectionId,
    remotePublicKey: null,
  };

  let connectionId: string;
  try {
    const result = await db
      .insert(connections)
      .values(newConnection)
      .onConflictDoUpdate({
        target: [
          connections.tenantId,
          connections.remoteConnectionId,
          connections.initiatedBy,
        ],
        set: {
          tenantId: newConnection.tenantId,
          remoteUrl: newConnection.remoteUrl,
          name: newConnection.name,
          role: newConnection.role,
          status: "pending",
          remoteTenantId: newConnection.remoteTenantId,
          updatedAt: new Date().toISOString(),
        },
      })
      .returning();

    if (!result[0]) {
      throw new Error("Failed to create connection record");
    }
    connectionId = result[0].id;
    log.info(
      `Connection staged: ${connectionId} (role=${role}, remoteConnectionId=${remoteConnectionId})`
    );
  } catch (error: any) {
    // Roll back a freshly created shadow so a failed insert leaves no orphan.
    if (shadowCreated) {
      await deleteTenant(remoteTenantId).catch(() => {});
    }
    log.error("Database error creating connection:", error);
    throw new Error(
      `Failed to create connection: ${error?.message || "Unknown error"}`
    );
  }

  const localServerUrl = _GLOBAL_SERVER_CONFIG.baseUrl;
  if (!localServerUrl) {
    throw new Error("Local server URL not configured");
  }

  try {
    const exchangeResult = await exchangePublicKeys(
      remoteUrl,
      remoteToken,
      remoteTenantId,
      serverPublicKey,
      remoteConnectionId,
      localServerUrl,
      name,
      localTenantId,
      localTenantName,
      oppositeRole(role)
    );

    // Handshake succeeded: activate and store the remote public key.
    await db
      .update(connections)
      .set({
        remotePublicKey: exchangeResult.remotePublicKey,
        status: "active",
        lastConnectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(connections.id, connectionId));

    // Following side: secure access to the adopted tenant, then (opt-in)
    // collapse to a pure mirror. Deletion runs last and is never rolled back.
    if (following && options.actingUserId) {
      await ensureOwnerOfAdoptedTenant(remoteTenantId, options.actingUserId);
    }
    if (following && options.replaceLocalTenants) {
      await deleteAllTenantsExcept(remoteTenantId);
    }

    log.info(`Connection initialized successfully: ${connectionId}`);

    await runPostConnectionActions({
      connectionId,
      localTenantId,
      remoteTenantId,
      remoteUrl,
      name,
      initiatedBy: "local",
      role,
    });

    return {
      connectionId,
      remoteConnectionId,
      localPublicKey: serverPublicKey,
      remotePublicKey: exchangeResult.remotePublicKey,
      status: "active",
    };
  } catch (error) {
    // Staging failed: undo everything created in this call. Nothing destructive
    // has run yet (adoption/cleanup only happen after success).
    log.error("Key exchange failed, rolling back staged connection:", error as object);
    await db
      .delete(connections)
      .where(eq(connections.id, connectionId))
      .catch((e) =>
        log.error("Failed to remove staged connection:", e as object)
      );
    if (shadowCreated) {
      await deleteTenant(remoteTenantId).catch((e) =>
        log.error("Failed to remove staged shadow tenant:", e as object)
      );
    }
    throw error;
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
 * @param role - This side's role for the connection (default "leading"). A
 *   leading side never shadows the remote tenant locally — it only records the
 *   remote tenant id on the connection. A following side mirrors the remote
 *   leader tenant (origin="remote").
 */
export async function acceptConnection(
  localTenantId: string,
  remoteUrl: string,
  remoteTenantId: string,
  remoteConnectionId: string,
  remotePublicKey: string,
  connectionName: string,
  remoteTenantName: string,
  role: ConnectionRole = "leading"
): Promise<ConnectionAcceptResult> {
  const db = getDb();
  const following = role === "following";

  try {
    log.info(
      `acceptConnection called: localTenantId=${localTenantId}, remoteTenantId=${remoteTenantId}, remoteConnectionId=${remoteConnectionId}, role=${role}, connectionName=${connectionName}`
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

    // Only a following side mirrors the remote (leader) tenant locally. A
    // leading side (the common case — the main server) must NOT create a shadow
    // of the connecting client: that is exactly what caused name collisions.
    if (following) {
      await upsertRemoteShadowTenant(remoteTenantId, remoteTenantName);
      log.info(
        `Adopted leader tenant ${remoteTenantId} locally (origin=remote) on accept`
      );
    }
    const ownerTenantId = following ? remoteTenantId : localTenantId;

    // Create connection record (initiated by remote).
    const newConnection: ConnectionsInsert = {
      tenantId: ownerTenantId,
      remoteUrl: remoteUrl,
      remotePublicKey: remotePublicKey,
      name: connectionName,
      initiatedBy: "remote",
      role,
      status: "active",
      remoteTenantId,
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
            role: newConnection.role,
            status: "active",
            remoteTenantId: newConnection.remoteTenantId,
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

    await runPostConnectionActions({
      connectionId,
      localTenantId,
      remoteTenantId,
      remoteUrl,
      name: connectionName,
      initiatedBy: "remote",
      role,
    });

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
      throw new ConnectionNotFoundError(
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
  connectionId: string,
  tenantId?: string
): Promise<{ token: string }> {
  try {
    // Get connection (scoped to the tenant when called from a request)
    const connection = await getConnection(connectionId, tenantId);
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
      // Scenario 2: the remote explicitly reports the connection no longer
      // exists (it was terminated there while this side could not be reached).
      // Only this precise, machine-readable signal triggers a local cleanup —
      // never a generic 401/5xx/network error, so we don't drop a connection
      // by accident when the remote is merely temporarily unhappy.
      if (response.status === 404) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (body?.error === "connection_not_found") {
          await dropConnection(connectionId, tenantId).catch((err) =>
            log.error(
              "Failed to drop local connection after remote reported it gone:",
              err as object
            )
          );
          throw new ConnectionGoneError(
            "Remote connection no longer exists; local connection removed."
          );
        }
      }

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
  connectionId: string,
  tenantId?: string
): Promise<ConnectionsSelect | null> {
  try {
    const db = getDb();
    // When a tenantId is supplied (request-facing calls), scope the lookup to
    // that tenant so connections of other tenants cannot be read by guessing
    // their id (IDOR — connection rows contain key material).
    const where = tenantId
      ? and(eq(connections.id, connectionId), eq(connections.tenantId, tenantId))
      : eq(connections.id, connectionId);
    const result = await db
      .select()
      .from(connections)
      .where(where)
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
export async function dropConnection(
  connectionId: string,
  tenantId?: string
): Promise<void> {
  try {
    const db = getDb();

    // Verify connection exists (and belongs to the tenant, when scoped)
    const connection = await getConnection(connectionId, tenantId);
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
 * Notify the remote side that we are terminating ("cancelling") the connection.
 *
 * Sends a request signed with our server private key (same signature scheme as
 * authenticate) to the remote's /connections/teardown endpoint. The remote
 * verifies the signature against the stored public key — that cryptographic
 * proof is sufficient authorization to drop its matching row. Best-effort: a
 * returned `false` (remote offline / unreachable / rejected) is expected and
 * handled by the local-delete-then-self-heal-later flow (scenario 2).
 */
async function notifyRemoteTeardown(
  connection: ConnectionsSelect
): Promise<boolean> {
  if (!connection.remoteUrl || !connection.remoteConnectionId) {
    return false;
  }
  try {
    const serverKey = await getServerKeys();
    if (!serverKey) return false;

    const timestamp = Date.now();
    const data = `${connection.remoteConnectionId}:${timestamp}`;
    const signature = signData(data, serverKey.privateKey);

    const res = await fetch(
      `${connection.remoteUrl}/api/v1/tenant/${connection.tenantId}/connections/teardown`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteConnectionId: connection.remoteConnectionId,
          timestamp,
          signature,
        }),
      }
    );

    if (!res.ok) {
      log.info(
        `Remote teardown not acknowledged for connection ${connection.id}: ${res.status}`
      );
      return false;
    }
    return true;
  } catch (error) {
    log.info(
      `Failed to notify remote of teardown for connection ${connection.id}: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
    return false;
  }
}

/**
 * Terminate ("cancel") a connection from this side.
 *
 * Either side may trigger this. Flow:
 * 1. Notify the remote (best-effort, signature-validated) so it deletes its
 *    matching row — scenario 1 (remote reachable: both sides delete cleanly).
 * 2. Always delete the local row afterwards — scenario 2 (remote offline: the
 *    local row goes away now; the remote learns about it on its next
 *    authenticate attempt, which then returns `connection_not_found`).
 *
 * Authorization for the teardown is the manual action plus, on the remote, the
 * cryptographic signature — no extra credentials are required.
 */
export async function disconnectConnection(
  connectionId: string,
  tenantId?: string
): Promise<DisconnectResult> {
  const connection = await getConnection(connectionId, tenantId);
  if (!connection) {
    throw new Error("Connection not found");
  }

  const remoteNotified = await notifyRemoteTeardown(connection);
  await dropConnection(connectionId, tenantId);

  log.info(
    `Connection disconnected: ${connectionId} (remoteNotified=${remoteNotified})`
  );
  return { connectionId, remoteNotified };
}

/**
 * Terminate all connections a tenant initiated locally.
 *
 * Used by the robot's "Abmelden" action — a robot holds exactly one such cloud
 * connection, but this stays correct if there happen to be several.
 */
export async function disconnectLocalConnections(
  tenantId: string
): Promise<{ disconnected: number; remoteNotified: number }> {
  const conns = await getConnectionByLocalTenant(tenantId, "local");
  let remoteNotified = 0;
  for (const conn of conns) {
    const result = await disconnectConnection(conn.id, tenantId);
    if (result.remoteNotified) remoteNotified++;
  }
  return { disconnected: conns.length, remoteNotified };
}

/**
 * Handle an incoming teardown ("cancellation") request from the remote side.
 *
 * Authenticated solely by the RSA signature over `${remoteConnectionId}:${timestamp}`,
 * verified against the stored remote public key — that proof is sufficient
 * authorization to drop the connection (it can only be issued by the holder of
 * the matching private key). Idempotent: a missing connection is treated as
 * already-torn-down and reported as a no-op rather than an error.
 */
export async function teardownConnectionBySignature(
  tenantId: string,
  remoteConnectionId: string,
  timestamp: number,
  signature: string
): Promise<{ removed: boolean }> {
  if (!tenantId || !remoteConnectionId || !timestamp || !signature) {
    throw new Error("Missing required teardown parameters");
  }

  // Reject stale requests (replay protection, 5 minute window) — same as authenticate.
  const now = Date.now();
  if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
    throw new Error("Timestamp expired");
  }

  const connection = await getConnectionByRemoteConnectionId(
    tenantId,
    remoteConnectionId
  );
  if (!connection) {
    // Already gone — nothing to tear down. Idempotent success.
    return { removed: false };
  }

  if (!connection.remotePublicKey) {
    throw new Error(
      "No remote public key found for connection. Cannot verify teardown request."
    );
  }

  const data = `${remoteConnectionId}:${timestamp}`;
  if (!verifySignature(data, signature, connection.remotePublicKey)) {
    throw new Error("Invalid signature");
  }

  const db = getDb();
  await db.delete(connections).where(eq(connections.id, connection.id));
  log.info(`Connection torn down by remote request: ${connection.id}`);
  return { removed: true };
}

/**
 * Refresh connection - update lastConnectedAt timestamp
 */
export async function refreshConnection(
  connectionId: string,
  tenantId?: string
): Promise<void> {
  try {
    const db = getDb();

    // Verify connection exists (and belongs to the tenant, when scoped)
    const connection = await getConnection(connectionId, tenantId);
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
// Code-based (OTP) remote authentication helpers
// ============================================================================

/**
 * Request a login code to be sent to the given email on the remote server.
 * Calls the remote's POST /api/v1/user/request-login-code.
 */
export async function requestRemoteLoginCode(
  remoteUrl: string,
  email: string
): Promise<void> {
  const res = await fetch(`${remoteUrl}/api/v1/user/request-login-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw new Error(`Failed to request login code: ${res.status}`);
  }
}

/**
 * Verify an OTP code with the remote server and retrieve available tenants.
 * Calls the remote's POST /api/v1/user/login-with-code, then GET /api/v1/user/tenants.
 * Returns the remote JWT token (to be used for initializeConnectionWithToken).
 */
export async function validateRemoteCredentialsWithCode(
  remoteUrl: string,
  email: string,
  code: string
): Promise<{ token: string; tenants: RemoteTenantInfo[] }> {
  const loginRes = await fetch(`${remoteUrl}/api/v1/user/login-with-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });

  if (!loginRes.ok) {
    const body = await loginRes.json().catch(() => ({})) as any;
    throw new Error(body?.error === "invalid_code" ? "Ungültiger oder abgelaufener Code." : `Login fehlgeschlagen: ${loginRes.status}`);
  }

  const { token } = await loginRes.json() as { token: string };
  if (!token) throw new Error("No token received from remote server");

  const tenantsRes = await fetch(`${remoteUrl}/api/v1/user/tenants`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!tenantsRes.ok) throw new Error(`Failed to fetch remote tenants: ${tenantsRes.status}`);

  const tenants = await tenantsRes.json() as RemoteTenantInfo[];
  return { token, tenants: tenants || [] };
}

/**
 * Initialize a connection using a pre-obtained remote JWT token (from OTP flow).
 * Equivalent to initializeConnection but skips credential validation.
 */
export async function initializeConnectionWithToken(
  localTenantId: string,
  remoteUrl: string,
  remoteToken: string,
  remoteTenantId: string,
  remoteTenantName: string,
  name: string,
  options: ConnectionInitOptions = {}
): Promise<ConnectionInitResult> {
  const serverKey = await getServerKeys();
  if (!serverKey) throw new Error("Server keys not found.");

  const localTenant = await getTenant(localTenantId);
  if (!localTenant) throw new Error(`Local tenant ${localTenantId} not found`);

  return await runInitiatingHandshake({
    role: options.role ?? "following",
    remoteUrl,
    remoteToken,
    remoteTenantId,
    remoteTenantName,
    name,
    localTenantId,
    localTenantName: localTenant.name,
    serverPublicKey: serverKey.publicKey,
    options,
  });
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
  requestRemoteLoginCode,
  validateRemoteCredentialsWithCode,

  // Connection management
  initializeConnection,
  initializeConnectionWithToken,
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
  disconnectConnection,
  disconnectLocalConnections,
  teardownConnectionBySignature,
  refreshConnection,
  cleanupStaleConnections,
};
