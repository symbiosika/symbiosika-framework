import { randomUUID } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  connections,
  type ConnectionsSelect,
} from "../db/db-schema";
import { encryptAes, decryptAes } from "../crypt/aes";
import log from "../log";

type ActiveConnection = {
  id: string;
  organisationId: string;
  socket: WebSocket;
};

class ConnectionsService {
  private active: Map<string, ActiveConnection> = new Map();
  private messageHandlers: Map<string, Set<(msg: any) => void>> = new Map();
  private globalHandlers: Set<(connectionId: string, msg: any) => void> = new Set();

  async createConnection(data: {
    organisationId: string;
    name?: string;
    remoteUrl?: string;
    initiatedBy: "client" | "server";
    createdByUserId?: string;
    // For server-to-server connections
    remoteOrganisationId?: string;
    authenticationType?: "none" | "api_token" | "basic_auth";
    remoteCredentials?: string; // API token or username:password
  }): Promise<ConnectionsSelect> {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const encrypted = encryptAes(privateKey);

    // Encrypt remote credentials if provided
    let encryptedCredentials: string | undefined;
    let credentialsType: string | undefined;
    if (data.remoteCredentials) {
      const encryptedCreds = encryptAes(data.remoteCredentials);
      encryptedCredentials = encryptedCreds.value;
      credentialsType = encryptedCreds.algorithm;
    }

    const [row] = await getDb()
      .insert(connections)
      .values({
        organisationId: data.organisationId,
        name: data.name,
        remoteUrl: data.remoteUrl,
        initiatedBy: data.initiatedBy,
        status: "pending",
        localPublicKey: publicKey,
        localPrivateKey: encrypted.value,
        localPrivateKeyType: encrypted.algorithm,
        createdByUserId: data.createdByUserId,
        remoteOrganisationId: data.remoteOrganisationId,
        authenticationType: data.authenticationType || "none",
        remoteCredentials: encryptedCredentials,
        remoteCredentialsType: credentialsType,
        meta: {},
      })
      .returning();

    return row;
  }

  async setRemotePublicKey(connectionId: string, publicKey: string) {
    const [updated] = await getDb()
      .update(connections)
      .set({ remotePublicKey: publicKey, updatedAt: new Date().toISOString() })
      .where(eq(connections.id, connectionId))
      .returning();
    return updated;
  }

  async createConnectToken(connectionId: string, ttlSeconds = 60) {
    const token = randomUUID();
    const exp = Date.now() + ttlSeconds * 1000;
    const [row] = await getDb()
      .update(connections)
      .set({
        meta: { connectToken: token, connectTokenExp: exp },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(connections.id, connectionId))
      .returning();
    return { token, exp, row };
  }

  async validateAndConsumeConnectToken(connectionId: string, token: string) {
    const [row] = await getDb()
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId));
    if (!row) return { ok: false, reason: "not_found" as const };
    const meta: any = row.meta || {};
    if (!meta.connectToken || meta.connectToken !== token)
      return { ok: false, reason: "invalid" as const };
    if (!meta.connectTokenExp || Date.now() > meta.connectTokenExp)
      return { ok: false, reason: "expired" as const };
    const wsKey = randomUUID();
    await getDb()
      .update(connections)
      .set({
        meta: { wsKey },
        status: "active",
        lastConnectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(connections.id, connectionId));
    return { ok: true as const, row, wsKey };
  }

  attachSocket(connectionId: string, organisationId: string, socket: any) {
    this.active.set(connectionId, { id: connectionId, organisationId, socket });
    const onClose = () => {
      this.active.delete(connectionId);
      getDb()
        .update(connections)
        .set({ status: "disconnected", updatedAt: new Date().toISOString() })
        .where(eq(connections.id, connectionId))
        .then(() => {})
        .catch((e) => log.error("Failed to update connection status", e + ""));
    };
    const onMessage = (evt: any) => {
      let raw = evt && typeof evt.data !== "undefined" ? evt.data : evt;
      let data: any = undefined;
      try {
        data = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        data = raw;
      }
      const handlers = this.messageHandlers.get(connectionId);
      if (handlers) {
        handlers.forEach((h) => {
          try {
            h(data);
          } catch {}
        });
      }
      this.globalHandlers.forEach((h) => {
        try {
          h(connectionId, data);
        } catch {}
      });
    };
    if (typeof socket.addEventListener === "function") {
      socket.addEventListener("close", onClose);
      socket.addEventListener("message", onMessage);
    } else {
      socket.onclose = onClose as any;
      socket.onmessage = (msg: any) => onMessage(msg);
    }
  }

  listOpen(organisationId?: string) {
    const entries = Array.from(this.active.values());
    return organisationId
      ? entries.filter((e) => e.organisationId === organisationId)
      : entries;
  }

  close(connectionId: string) {
    const entry = this.active.get(connectionId);
    if (entry) {
      try {
        entry.socket.close();
      } catch {}
      this.active.delete(connectionId);
    }
  }

  sendJson(connectionId: string, message: any) {
    const entry = this.active.get(connectionId);
    if (!entry) throw new Error("Connection not found or not open");
    entry.socket.send(JSON.stringify(message));
  }

  onMessage(connectionId: string, handler: (msg: any) => void) {
    if (!this.messageHandlers.has(connectionId)) {
      this.messageHandlers.set(connectionId, new Set());
    }
    this.messageHandlers.get(connectionId)!.add(handler);
    return () => this.messageHandlers.get(connectionId)!.delete(handler);
  }

  onAnyMessage(handler: (connectionId: string, msg: any) => void) {
    this.globalHandlers.add(handler);
    return () => this.globalHandlers.delete(handler);
  }

  /**
   * Get authentication bearer token for remote server
   * @param remoteBaseUrl Base URL of remote server (e.g. https://server.tld/api/v1)
   * @param authenticationType Type of authentication
   * @param credentials API token or username:password
   * @returns Bearer token for Authorization header
   */
  private async getRemoteAuthToken(
    remoteBaseUrl: string,
    authenticationType: "none" | "api_token" | "basic_auth",
    credentials?: string
  ): Promise<string> {
    if (authenticationType === "api_token" && credentials) {
      // Direct API token usage
      return credentials;
    }

    if (authenticationType === "basic_auth" && credentials) {
      // Login with username:password to get JWT token
      const [username, password] = credentials.split(":", 2);
      if (!username || !password) {
        throw new Error("Invalid credentials format. Expected username:password");
      }

      const apiBase = remoteBaseUrl.replace(/\/$/, "");
      const loginRes = await fetch(`${apiBase}/user/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!loginRes.ok) {
        throw new Error(`Remote login failed: ${loginRes.status} ${loginRes.statusText}`);
      }

      const loginData: any = await loginRes.json();
      if (!loginData.token) {
        throw new Error("Remote login did not return a token");
      }

      return loginData.token;
    }

    throw new Error("No valid authentication method provided");
  }

  /**
   * Connect to a remote server
   * Creates a local connection entry, authenticates with remote server,
   * initiates connection on remote server, and establishes WebSocket
   * 
   * @param params Connection parameters including credentials
   * @returns Local and remote connection IDs
   */
  async connectToServer(params: {
    organisationId: string;
    remoteBaseUrl: string; // e.g. https://server.tld/api/v1
    remoteOrganisationId: string;
    authenticationType: "api_token" | "basic_auth";
    credentials: string; // API token or username:password
    name?: string;
    createdByUserId?: string;
  }) {
    // First, create local connection with encrypted credentials
    const localRow = await this.createConnection({
      organisationId: params.organisationId,
      name: params.name,
      remoteUrl: params.remoteBaseUrl,
      initiatedBy: "server",
      createdByUserId: params.createdByUserId,
      remoteOrganisationId: params.remoteOrganisationId,
      authenticationType: params.authenticationType,
      remoteCredentials: params.credentials,
    });

    try {
      // Authenticate with remote server
      const bearerToken = await this.getRemoteAuthToken(
        params.remoteBaseUrl,
        params.authenticationType,
        params.credentials
      );

      const apiBase = params.remoteBaseUrl.replace(/\/$/, "");

      // Initialize connection on remote server
      const initRes = await fetch(
        `${apiBase}/organisation/${params.remoteOrganisationId}/connections/init`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bearerToken}`,
          },
          body: JSON.stringify({ 
            name: params.name || `Connection from ${params.organisationId}`,
            initiatedBy: "server" 
          }),
        }
      );

      if (!initRes.ok) {
        const errorText = await initRes.text();
        throw new Error(`Remote init failed: ${initRes.status} ${errorText}`);
      }

      const initJson: any = await initRes.json();
      const remoteConnectionId: string = initJson.id;
      const connectToken: string = initJson.meta?.connectToken;
      const serversPublicKey: string = initJson.localPublicKey;

      if (!connectToken || !serversPublicKey) {
        throw new Error("Remote server did not provide connect token or public key");
      }

      // Update local connection with remote details
      await getDb()
        .update(connections)
        .set({ 
          remotePublicKey: serversPublicKey,
          remoteConnectionId: remoteConnectionId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, localRow.id));

      // Connect to remote server
      const connectRes = await fetch(
        `${apiBase}/organisation/${params.remoteOrganisationId}/connections/connect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId: remoteConnectionId,
            connectToken,
            clientPublicKey: localRow.localPublicKey,
          }),
        }
      );

      if (!connectRes.ok) {
        const errorText = await connectRes.text();
        throw new Error(`Remote connect failed: ${connectRes.status} ${errorText}`);
      }

      const connectJson: any = await connectRes.json();
      const wsKey: string = connectJson.wsKey;

      if (!wsKey) {
        throw new Error("Remote server did not provide WebSocket key");
      }

      // Store wsKey for reconnects
      await getDb()
        .update(connections)
        .set({ 
          meta: { wsKey, remoteConnectionId },
          status: "active",
          lastConnectedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, localRow.id));

      // Establish WebSocket connection
      const wsUrl = `${apiBase.replace(/^http/, "ws")}/organisation/${params.remoteOrganisationId}/connections/${remoteConnectionId}/ws?key=${encodeURIComponent(wsKey)}`;
      const ws = new WebSocket(wsUrl, ["json"]);

      return new Promise<{ localConnectionId: string; remoteConnectionId: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("WebSocket connection timeout"));
        }, 30000); // 30 second timeout

        ws.addEventListener("open", () => {
          clearTimeout(timeout);
          this.attachSocket(localRow.id, params.organisationId, ws);
          log.info("Connected to remote server", { 
            localConnectionId: localRow.id, 
            remoteConnectionId 
          });
          resolve({ localConnectionId: localRow.id, remoteConnectionId });
        });

        ws.addEventListener("error", (error) => {
          clearTimeout(timeout);
          log.error("WebSocket connection error", error);
          reject(new Error("WebSocket connection failed"));
        });

        ws.addEventListener("close", () => {
          // handled in attachSocket close listener
        });
      });
    } catch (error) {
      // If connection failed, mark local connection as failed
      await getDb()
        .update(connections)
        .set({ 
          status: "revoked",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, localRow.id))
        .catch(() => {}); // Ignore cleanup errors
      
      throw error;
    }
  }

  /**
   * Reconnect to a remote server using stored connection details
   * @param connectionId Local connection ID
   * @returns Connection ID on success
   */
  async reconnect(connectionId: string): Promise<string> {
    // Get connection details from database
    const [row] = await getDb()
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId));

    if (!row) {
      throw new Error("Connection not found");
    }

    if (!row.remoteUrl || !row.remoteOrganisationId || !row.remoteConnectionId) {
      throw new Error("Connection is missing remote details");
    }

    const meta: any = row.meta || {};
    let wsKey = meta.wsKey;

    // If no wsKey, need to re-authenticate
    if (!wsKey) {
      if (!row.remoteCredentials || !row.remoteCredentialsType) {
        throw new Error("Connection has no stored credentials for re-authentication");
      }

      // Decrypt credentials
      const decrypted = decryptAes(row.remoteCredentials, row.remoteCredentialsType);
      const credentials = decrypted.value;

      // Re-authenticate and get new token
      const bearerToken = await this.getRemoteAuthToken(
        row.remoteUrl,
        row.authenticationType || "api_token",
        credentials
      );

      // Get new connect token from remote server
      const apiBase = row.remoteUrl.replace(/\/$/, "");
      const tokenRes = await fetch(
        `${apiBase}/organisation/${row.remoteOrganisationId}/connections/${row.remoteConnectionId}/reconnect`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bearerToken}`,
          },
        }
      );

      if (!tokenRes.ok) {
        throw new Error(`Failed to get reconnect token: ${tokenRes.status}`);
      }

      const tokenData: any = await tokenRes.json();
      wsKey = tokenData.wsKey;

      // Store new wsKey
      await getDb()
        .update(connections)
        .set({ 
          meta: { ...meta, wsKey },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, connectionId));
    }

    // Establish WebSocket connection
    const apiBase = row.remoteUrl.replace(/\/$/, "");
    const wsUrl = `${apiBase.replace(/^http/, "ws")}/organisation/${row.remoteOrganisationId}/connections/${row.remoteConnectionId}/ws?key=${encodeURIComponent(wsKey)}`;
    const ws = new WebSocket(wsUrl, ["json"]);

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Reconnection timeout"));
      }, 30000);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        this.attachSocket(connectionId, row.organisationId, ws);
        getDb()
          .update(connections)
          .set({ 
            status: "active",
            lastConnectedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(connections.id, connectionId))
          .then(() => {})
          .catch(() => {});
        log.info("Reconnected to remote server", { connectionId });
        resolve(connectionId);
      });

      ws.addEventListener("error", (error) => {
        clearTimeout(timeout);
        log.error("Reconnection error", error);
        reject(new Error("Reconnection failed"));
      });
    });
  }
}

export const connectionsService = new ConnectionsService();


