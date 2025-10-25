/**
 * Routes to manage server-to-server connections
 * These routes are protected by JWT and CheckPermission middleware
 */

import type { FastAppHono } from "../../../../types";
import { HTTPException } from "hono/http-exception";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../lib/utils/hono-middlewares";
import { connectionsService } from "../../../../lib/connections";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import log from "../../../../lib/log";
import { validateScope } from "../../../../lib/utils/validate-scope";

/**
 * Define connections routes
 */
const defineConnectionsRoutes = (app: FastAppHono, basePath: string) => {
  const baseRoute = `${basePath}/organisation/:organisationId/connections`;

  /**
   * POST /validate-credentials
   * Validate remote server credentials and list organisations
   */
  app.post(
    `${baseRoute}/validate-credentials`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator(
      "json",
      v.object({
        remoteUrl: v.string("Remote URL is required"),
        email: v.string("Email is required"),
        password: v.string("Password is required"),
      })
    ),
    validateScope("connections:write"),
    describeRoute({
      description: "Validate remote server credentials",
      responses: {
        200: {
          description: "Credentials validated successfully",
        },
        400: {
          description: "Invalid credentials or server error",
        },
      },
    }),
    async (c) => {
      try {
        const { remoteUrl, email, password } = c.req.valid("json");

        const result = await connectionsService.validateRemoteCredentials(
          remoteUrl,
          email,
          password
        );

        return c.json({
          organisations: result.organisations,
        });
      } catch (error) {
        log.error("Error validating credentials:", error as object);
        throw new HTTPException(400, {
          message: error instanceof Error ? error.message : "Validation failed",
        });
      }
    }
  );

  /**
   * POST /init
   * Initialize a new connection to a remote server
   */
  app.post(
    `${baseRoute}/init`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator(
      "json",
      v.object({
        remoteUrl: v.string("Remote URL is required"),
        remoteEmail: v.string("Remote email is required"),
        remotePassword: v.string("Remote password is required"),
        remoteOrganisationId: v.string("Remote organisation ID is required"),
        name: v.string("Connection name is required"),
      })
    ),
    validator("param", v.object({ organisationId: v.string() })),
    validateScope("connections:write"),
    describeRoute({
      description: "Initialize connection to remote server",
      responses: {
        201: {
          description: "Connection initialized successfully",
        },
        400: {
          description: "Invalid request or connection failed",
        },
      },
    }),
    async (c) => {
      try {
        const { organisationId } = c.req.valid("param");
        const { remoteUrl, remoteEmail, remotePassword, remoteOrganisationId, name } =
          c.req.valid("json");

        const result = await connectionsService.initializeConnection(
          organisationId,
          remoteUrl,
          remoteEmail,
          remotePassword,
          remoteOrganisationId,
          name
        );

        return c.json(result, 201);
      } catch (error) {
        log.error("Error initializing connection:", error as object);
        throw new HTTPException(400, {
          message: error instanceof Error ? error.message : "Connection failed",
        });
      }
    }
  );

  /**
   * POST /exchange-keys
   * Receive and respond to public key exchange (called by remote server)
   */
  app.post(
    `${baseRoute}/exchange-keys`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator(
      "json",
      v.object({
        localPublicKey: v.string("Local public key is required"),
        remoteConnectionId: v.string("Remote connection ID is required"),
      })
    ),
    validator("param", v.object({ organisationId: v.string() })),
    validateScope("connections:write"),
    async (c) => {
      try {
        const { organisationId } = c.req.valid("param");
        const { localPublicKey, remoteConnectionId } = c.req.valid("json");

        // Get or create connection from remote
        let connection = await connectionsService.getConnection(remoteConnectionId);

        if (!connection) {
          // Create new connection for server-initiated connection
          const allConnections = await connectionsService.listConnections(organisationId);
          connection =
            allConnections.find((conn) => conn.remoteConnectionId === remoteConnectionId) ||
            null;
        }

        if (!connection) {
          throw new Error("Connection not found");
        }

        // Get our public key
        const ourPublicKey = connection.localPublicKey;

        return c.json({
          remotePublicKey: ourPublicKey,
          remoteConnectionId: connection.id,
        });
      } catch (error) {
        log.error("Error exchanging keys:", error as object);
        throw new HTTPException(400, {
          message: error instanceof Error ? error.message : "Key exchange failed",
        });
      }
    }
  );

  /**
   * GET /
   * List all connections for this organisation
   */
  app.get(
    `${baseRoute}`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator("param", v.object({ organisationId: v.string() })),
    validateScope("connections:read"),
    describeRoute({
      description: "List all connections",
      responses: {
        200: {
          description: "Connections retrieved successfully",
        },
      },
    }),
    async (c) => {
      try {
        const { organisationId } = c.req.valid("param");
        const conns = await connectionsService.listConnections(organisationId);

        return c.json({
          connections: conns,
        });
      } catch (error) {
        log.error("Error listing connections:", error as object);
        throw new HTTPException(500, {
          message: "Failed to list connections",
        });
      }
    }
  );

  /**
   * GET /:connectionId
   * Get a specific connection
   */
  app.get(
    `${baseRoute}/:connectionId`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator("param", v.object({ connectionId: v.string() })),
    validateScope("connections:read"),
    async (c) => {
      try {
        const { connectionId } = c.req.valid("param");
        const connection = await connectionsService.getConnection(connectionId);

        if (!connection) {
          throw new HTTPException(404, {
            message: "Connection not found",
          });
        }

        return c.json(connection);
      } catch (error) {
        if (error instanceof HTTPException) throw error;
        log.error("Error getting connection:", error as object);
        throw new HTTPException(500, {
          message: "Failed to get connection",
        });
      }
    }
  );

  /**
   * GET /:connectionId/sessions
   * List all sessions for a connection
   */
  app.get(
    `${baseRoute}/:connectionId/sessions`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator("param", v.object({ connectionId: v.string() })),
    validateScope("connections:read"),
    async (c) => {
      try {
        const { connectionId } = c.req.valid("param");
        const sessions = await connectionsService.listConnectionSessions(connectionId);

        return c.json({
          sessions,
        });
      } catch (error) {
        log.error("Error listing sessions:", error as object);
        throw new HTTPException(500, {
          message: "Failed to list sessions",
        });
      }
    }
  );

  /**
   * DELETE /:connectionId/sessions/:sessionId
   * Drop a specific session
   */
  app.delete(
    `${baseRoute}/:connectionId/sessions/:sessionId`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator(
      "param",
      v.object({ connectionId: v.string(), sessionId: v.string() })
    ),
    validateScope("connections:write"),
    async (c) => {
      try {
        const { sessionId } = c.req.valid("param");
        await connectionsService.dropConnectionSession(sessionId);

        return c.json({
          message: "Session dropped successfully",
        });
      } catch (error) {
        log.error("Error dropping session:", error as object);
        throw new HTTPException(500, {
          message: "Failed to drop session",
        });
      }
    }
  );

  /**
   * DELETE /:connectionId
   * Drop a connection and all its sessions
   */
  app.delete(
    `${baseRoute}/:connectionId`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator("param", v.object({ connectionId: v.string() })),
    validateScope("connections:write"),
    async (c) => {
      try {
        const { connectionId } = c.req.valid("param");
        await connectionsService.dropConnection(connectionId);

        return c.json({
          message: "Connection dropped successfully",
        });
      } catch (error) {
        log.error("Error dropping connection:", error as object);
        throw new HTTPException(500, {
          message: "Failed to drop connection",
        });
      }
    }
  );
};

export default defineConnectionsRoutes;
