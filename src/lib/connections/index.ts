import { randomUUID } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import {
  connections,
  type ConnectionsSelect,
} from "../db/db-schema";
import { encryptAes } from "../crypt/aes";
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
  }): Promise<ConnectionsSelect> {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const encrypted = encryptAes(privateKey);

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

  async connectToServer(params: {
    organisationId: string;
    remoteBaseUrl: string; // e.g. https://server.tld/api/v1
    remoteOrganisationId: string;
    remoteAdminBearerToken: string;
    name?: string;
  }) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const encrypted = encryptAes(privateKey);

    const [localRow] = await getDb()
      .insert(connections)
      .values({
        organisationId: params.organisationId,
        name: params.name,
        remoteUrl: params.remoteBaseUrl,
        initiatedBy: "client",
        status: "pending",
        localPublicKey: publicKey,
        localPrivateKey: encrypted.value,
        localPrivateKeyType: encrypted.algorithm,
        meta: {},
      })
      .returning();

    const apiBase = params.remoteBaseUrl.replace(/\/$/, "");
    const initRes = await fetch(
      `${apiBase}/organisation/${params.remoteOrganisationId}/connections/init`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.remoteAdminBearerToken}`,
        },
        body: JSON.stringify({ name: params.name, initiatedBy: "client" }),
      }
    );
    if (!initRes.ok) throw new Error("Remote init failed");
    const initJson: any = await initRes.json();
    const remoteConnectionId: string = initJson.id;
    const connectToken: string = initJson.meta?.connectToken;
    const serversPublicKey: string = initJson.localPublicKey;

    // persist server public key
    await getDb()
      .update(connections)
      .set({ remotePublicKey: serversPublicKey })
      .where(eq(connections.id, localRow.id));

    const connectRes = await fetch(
      `${apiBase}/organisation/${params.remoteOrganisationId}/connections/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: remoteConnectionId,
          connectToken,
          clientPublicKey: publicKey,
        }),
      }
    );
    if (!connectRes.ok) throw new Error("Remote connect failed");
    const connectJson: any = await connectRes.json();
    const wsKey: string = connectJson.wsKey;

    // store wsKey for reconnects
    await getDb()
      .update(connections)
      .set({ meta: { wsKey }, status: "active" })
      .where(eq(connections.id, localRow.id));

    const wsUrl = `${apiBase.replace(/^http/, "ws")}/organisation/${params.remoteOrganisationId}/connections/${remoteConnectionId}/ws?key=${encodeURIComponent(wsKey)}`;
    const ws = new WebSocket(wsUrl, ["json"]);
    ws.addEventListener("open", () => {
      this.attachSocket(localRow.id, params.organisationId, ws);
    });
    ws.addEventListener("close", () => {
      // handled in attachSocket close listener
    });
    return { localConnectionId: localRow.id, remoteConnectionId };
  }

  async reconnect(connectionId: string, remoteBaseUrl: string, remoteOrganisationId: string, remoteConnectionId: string, wsKey: string, organisationId: string) {
    const apiBase = remoteBaseUrl.replace(/\/$/, "");
    const wsUrl = `${apiBase.replace(/^http/, "ws")}/organisation/${remoteOrganisationId}/connections/${remoteConnectionId}/ws?key=${encodeURIComponent(wsKey)}`;
    const ws = new WebSocket(wsUrl, ["json"]);
    ws.addEventListener("open", () => {
      this.attachSocket(connectionId, organisationId, ws);
    });
    return connectionId;
  }
}

export const connectionsService = new ConnectionsService();


