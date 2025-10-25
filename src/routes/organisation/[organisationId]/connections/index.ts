import type { FastAppHono } from "../../../../types";
import { describeRoute } from "hono-openapi";
import { upgradeWebSocket } from "hono/bun";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
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

export default function defineConnectionsRoutes(
  app: FastAppHono,
  API_BASE_PATH: string
) {
  // Init a new connection: creates keys and returns connection with a short-lived connect token
  app.post(
    API_BASE_PATH + "/organisation/:organisationId/connections/init",
    authAndSetUsersInfo,
    checkUserPermission,
    isOrganisationMember,
    describeRoute({
      tags: ["connections"],
      summary: "Initialize a new connection",
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
        initiatedBy: payload.initiatedBy || "client",
        createdByUserId: userId,
      });

      const token = await connectionsService.createConnectToken(row.id);
      return c.json({ ...row, meta: { connectToken: token.token, connectTokenExp: token.exp } });
    }
  );

  // Client connects using existing key: validates token, sets remote public key and upgrades to WS
  app.post(
    API_BASE_PATH + "/organisation/:organisationId/connections/connect",
    describeRoute({
      tags: ["connections"],
      summary: "Connect using existing key",
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
          createdAt: connections.createdAt,
          updatedAt: connections.updatedAt,
          lastConnectedAt: connections.lastConnectedAt,
        })
        .from(connections)
        .where(eq(connections.organisationId, organisationId));
      return c.json(rows);
    }
  );
}


