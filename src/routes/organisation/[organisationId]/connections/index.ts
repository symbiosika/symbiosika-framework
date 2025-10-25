import type { FastAppHono } from "../../../../types";
import { describeRoute } from "hono-openapi";
import { upgradeWebSocket } from "hono/bun";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { randomUUID } from "node:crypto";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../lib/utils/hono-middlewares";
import { isOrganisationMember } from "../..";
import {
  connectionsInsertSchema,
  connectionsSelectSchema,
} from "../../../../lib/db/db-schema";
import { connectionsService } from "../../../../lib/connections";
import { getDb } from "../../../../lib/db/db-connection";
import { and, eq } from "drizzle-orm";
import { connections } from "../../../../lib/db/db-schema";
import { validateScope } from "../../../../lib/utils/validate-scope";
import { HTTPException } from "hono/http-exception";
import log from "../../../../lib/log";

const initSchema = v.object({
  name: v.optional(v.string()),
  remoteUrl: v.optional(v.string()),
  initiatedBy: v.optional(v.picklist(["client", "server"]), "client"),
});

const connectSchema = v.object({
  connectionId: v.string(),
  connectToken: v.string(),
  clientPublicKey: v.string(),
});

const connectToServerSchema = v.object({
  name: v.optional(v.string()),
  remoteBaseUrl: v.string(),
  remoteOrganisationId: v.string(),
  authenticationType: v.picklist(["api_token", "basic_auth"]),
  credentials: v.string(), // API token or username:password
});

export default function defineConnectionsRoutes(
  app: FastAppHono,
  API_BASE_PATH: string
) {
  // INCOMING: Init a new connection (called by remote servers connecting to this server)
  // Creates keys and returns connection with a short-lived connect token
  app.post(
    API_BASE_PATH + "/organisation/:organisationId/connections/init",
    authAndSetUsersInfo,
    checkUserPermission,
    isOrganisationMember,
    describeRoute({
      tags: ["connections"],
      summary: "[INCOMING] Initialize a new connection",
      description: "Called by remote servers to initiate a connection to this server",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(connectionsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("connections:write"),
    validator("json", initSchema),
    async (c) => {
      const organisationId = c.req.param("organisationId")!;
      const userId = c.get("usersId");
      const payload = c.req.valid("json");

      const row = await connectionsService.createConnection({
        organisationId,
        name: payload.name,
        remoteUrl: payload.remoteUrl,
        initiatedBy: payload.initiatedBy || "server",
        createdByUserId: userId,
      });

      const token = await connectionsService.createConnectToken(row.id);
      return c.json({ ...row, meta: { connectToken: token.token, connectTokenExp: token.exp } });
    }
  );

  // INCOMING: Validate connect token and establish connection (called by remote servers)
  app.post(
    API_BASE_PATH + "/organisation/:organisationId/connections/connect",
    describeRoute({
      tags: ["connections"],
      summary: "[INCOMING] Connect using token",
      description: "Called by remote servers to finalize connection with connect token",
      responses: { 200: { description: "OK" } },
    }),
    validator("json", connectSchema),
    async (c) => {
      const organisationId = c.req.param("organisationId")!;
      const body = c.req.valid("json");
      const { connectionId, connectToken, clientPublicKey } = body;

      const res = await connectionsService.validateAndConsumeConnectToken(
        connectionId,
        connectToken
      );
      if (!res.ok) {
        throw new HTTPException(400, { message: `Connect token ${res.reason}` });
      }
      const [row] = await getDb()
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId));
      if (!row || row.organisationId !== organisationId) {
        throw new HTTPException(403, { message: "Organisation mismatch" });
      }
      await connectionsService.setRemotePublicKey(connectionId, clientPublicKey);
      return c.json({ status: "ok", wsKey: res.wsKey });
    }
  );

  // WS endpoint to actually attach websocket after connect approved
  app.get(
    API_BASE_PATH + "/organisation/:organisationId/connections/:connectionId/ws",
    upgradeWebSocket(async (c) => {
      const organisationId = c.req.param("organisationId")!;
      const connectionId = c.req.param("connectionId")!;
      const wsKey = c.req.query("key") || "";

      const [row] = await getDb()
        .select()
        .from(connections)
        .where(
          and(eq(connections.id, connectionId), eq(connections.organisationId, organisationId))
        );
      if (!row || row.status !== "active") {
        throw new HTTPException(403, { message: "Connection not active" });
      }
      const meta: any = row.meta || {};
      if (!wsKey || wsKey !== meta.wsKey) {
        throw new HTTPException(403, { message: "Invalid key" });
      }

      return {
        onOpen(ws) {
          connectionsService.attachSocket(connectionId, organisationId, ws as any);
          log.info("WebSocket opened", { connectionId, organisationId });
        },
        onMessage(ws, message: unknown) {
          try {
            let text = "";
            if (typeof message === "string") {
              text = message;
            } else if (message instanceof ArrayBuffer) {
              text = new TextDecoder().decode(new Uint8Array(message));
            } else if (message && typeof (message as any).data !== "undefined") {
              const data = (message as any).data;
              text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
            }
            (ws as any).send(text);
          } catch {
            log.error("Error sending message", { connectionId, organisationId, message });
          }
        },
        onClose() {
          log.info("WebSocket closed", { connectionId, organisationId });
        },
      };
    })
  );

  // List connections
  app.get(
    API_BASE_PATH + "/organisation/:organisationId/connections",
    authAndSetUsersInfo,
    checkUserPermission,
    isOrganisationMember,
    describeRoute({
      tags: ["connections"],
      summary: "List connections",
      responses: {
        200: { description: "OK" },
      },
    }),
    validateScope("connections:read"),
    async (c) => {
      const organisationId = c.req.param("organisationId")!;
      const rows = await getDb()
        .select({
          id: connections.id,
          organisationId: connections.organisationId,
          name: connections.name,
          remoteUrl: connections.remoteUrl,
          initiatedBy: connections.initiatedBy,
          status: connections.status,
          localPublicKey: connections.localPublicKey,
          remotePublicKey: connections.remotePublicKey,
          remoteOrganisationId: connections.remoteOrganisationId,
          remoteConnectionId: connections.remoteConnectionId,
          authenticationType: connections.authenticationType,
          createdAt: connections.createdAt,
          updatedAt: connections.updatedAt,
          lastConnectedAt: connections.lastConnectedAt,
        })
        .from(connections)
        .where(eq(connections.organisationId, organisationId));
      return c.json(rows);
    }
  );

  // OUTGOING: Connect to a remote server (server-to-server)
  app.post(
    API_BASE_PATH + "/organisation/:organisationId/connections/connect-to-server",
    authAndSetUsersInfo,
    checkUserPermission,
    isOrganisationMember,
    describeRoute({
      tags: ["connections"],
      summary: "[OUTGOING] Connect to a remote server",
      description: "Initiates an outgoing connection to a remote server using API token or username/password authentication",
      responses: {
        200: {
          description: "Connection established",
          content: {
            "application/json": {
              schema: v.object({
                localConnectionId: v.string(),
                remoteConnectionId: v.string(),
              }),
            },
          },
        },
      },
    }),
    validateScope("connections:write"),
    validator("json", connectToServerSchema),
    async (c) => {
      const organisationId = c.req.param("organisationId")!;
      const userId = c.get("usersId");
      const payload = c.req.valid("json");

      try {
        const result = await connectionsService.connectToServer({
          organisationId,
          remoteBaseUrl: payload.remoteBaseUrl,
          remoteOrganisationId: payload.remoteOrganisationId,
          authenticationType: payload.authenticationType,
          credentials: payload.credentials, 
          name: payload.name,
          createdByUserId: userId,
        });

        return c.json(result);
      } catch (error: any) {
        log.error("Failed to connect to server", { error: error.message, organisationId });
        throw new HTTPException(500, { message: error.message || "Failed to connect to server" });
      }
    }
  );

  // INCOMING: Generate new WebSocket key for reconnection (called by remote servers)
  app.post(
    API_BASE_PATH + "/organisation/:organisationId/connections/:connectionId/reconnect",
    authAndSetUsersInfo,
    checkUserPermission,
    isOrganisationMember,
    describeRoute({
      tags: ["connections"],
      summary: "[INCOMING] Generate new reconnect key",
      description: "Generates a new WebSocket key for reconnecting to an existing connection. Called by remote servers when they need to reconnect.",
      responses: {
        200: {
          description: "New wsKey generated",
          content: {
            "application/json": {
              schema: v.object({
                wsKey: v.string(),
              }),
            },
          },
        },
      },
    }),
    validateScope("connections:write"),
    async (c) => {
      const organisationId = c.req.param("organisationId")!;
      const connectionId = c.req.param("connectionId")!;

      // Verify connection belongs to this organisation
      const [row] = await getDb()
        .select()
        .from(connections)
        .where(
          and(eq(connections.id, connectionId), eq(connections.organisationId, organisationId))
        );

      if (!row) {
        throw new HTTPException(404, { message: "Connection not found" });
      }

      // Generate new wsKey
      const wsKey = randomUUID();
      await getDb()
        .update(connections)
        .set({
          meta: { ...(row.meta || {}), wsKey },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, connectionId));

      return c.json({ wsKey });
    }
  );

  // Delete/Close a connection
  app.delete(
    API_BASE_PATH + "/organisation/:organisationId/connections/:connectionId",
    authAndSetUsersInfo,
    checkUserPermission,
    isOrganisationMember,
    describeRoute({
      tags: ["connections"],
      summary: "Close and delete a connection",
      description: "Closes the WebSocket and marks the connection as revoked",
      responses: {
        200: { description: "Connection closed" },
      },
    }),
    validateScope("connections:write"),
    async (c) => {
      const organisationId = c.req.param("organisationId")!;
      const connectionId = c.req.param("connectionId")!;

      // Verify connection belongs to this organisation
      const [row] = await getDb()
        .select()
        .from(connections)
        .where(
          and(eq(connections.id, connectionId), eq(connections.organisationId, organisationId))
        );

      if (!row) {
        throw new HTTPException(404, { message: "Connection not found" });
      }

      // Close WebSocket
      connectionsService.close(connectionId);

      // Mark as revoked
      await getDb()
        .update(connections)
        .set({
          status: "revoked",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connections.id, connectionId));

      return c.json({ status: "closed" });
    }
  );
}


