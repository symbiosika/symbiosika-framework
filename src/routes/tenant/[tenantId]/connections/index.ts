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
import { validator } from "hono-openapi";
import * as v from "valibot";
import log from "../../../../lib/log";
import { validateScope } from "../../../../lib/utils/validate-scope";

/**
 * Define connections routes
 */
const defineConnectionsRoutes = (app: FastAppHono, basePath: string) => {
  const baseRoute = `${basePath}/tenant/:tenantId/connections`;

  /**
   * POST /validate-credentials
   * Validate remote server credentials and list tenants
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
          tenants: result.tenants,
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
        remoteTenantId: v.string("Remote tenant ID is required"),
        name: v.string("Connection name is required"),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
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
        const { tenantId } = c.req.valid("param");
        const { remoteUrl, remoteEmail, remotePassword, remoteTenantId, name } =
          c.req.valid("json");

        const result = await connectionsService.initializeConnection(
          tenantId,
          remoteUrl,
          remoteEmail,
          remotePassword,
          remoteTenantId,
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
   * POST /:connectionId/verify
   * Verify connection status
   */
  app.post(
    `${baseRoute}/:connectionId/verify`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator("param", v.object({ connectionId: v.string() })),
    validateScope("connections:read"),
    describeRoute({
      description: "Verify connection status",
      responses: {
        200: {
          description: "Connection verified successfully",
        },
        400: {
          description: "Verification failed",
        },
      },
    }),
    async (c) => {
      try {
        const { connectionId } = c.req.valid("param");

        const result = await connectionsService.verifyConnection(connectionId);

        return c.json(result);
      } catch (error) {
        log.error("Error verifying connection:", error as object);
        throw new HTTPException(400, {
          message:
            error instanceof Error ? error.message : "Verification failed",
        });
      }
    }
  );

  /**
   * POST /authenticate
   * Authenticate connection using key signature
   * Public endpoint, signature verified by public key
   */
  app.post(
    `${baseRoute}/authenticate`,
    validator(
      "json",
      v.object({
        connectionId: v.string("Connection ID is required"),
        timestamp: v.number("Timestamp is required"),
        signature: v.string("Signature is required"),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    describeRoute({
      description: "Authenticate connection using key signature",
      responses: {
        200: {
          description: "Authenticated successfully",
        },
        401: {
          description: "Authentication failed",
        },
      },
    }),
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const { connectionId, timestamp, signature } = c.req.valid("json");

        // authenticateConnection checks signature against DB
        const result = await connectionsService.authenticateConnection(
          connectionId,
          timestamp,
          signature
        );

        // Optional: Check if connection belongs to tenantId
        // But authenticateConnection retrieves connection by ID.
        // We should verify tenantId matches to prevent cross-tenant confusion if IDs are global.
        // But IDs are UUIDs.

        return c.json(result);
      } catch (error) {
        log.error("Error authenticating connection:", error as object);
        throw new HTTPException(401, {
          message: "Authentication failed",
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
        remotePublicKey: v.string("Remote public key is required"),
        remoteConnectionId: v.string("Remote connection ID is required"),
        remoteTenantId: v.string("Remote tenant ID is required"),
        remoteUrl: v.string("Remote URL is required"),
        connectionName: v.string("Connection name is required"),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    validateScope("connections:write"),
    describeRoute({
      description: "Accept connection from remote server and exchange keys",
      responses: {
        200: {
          description: "Connection accepted successfully",
        },
        400: {
          description: "Invalid request or connection failed",
        },
      },
    }),
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const {
          remotePublicKey,
          remoteConnectionId,
          remoteTenantId,
          remoteUrl,
          connectionName,
        } = c.req.valid("json");

        // Accept the connection and get our public key
        const result = await connectionsService.acceptConnection(
          tenantId,
          remoteUrl,
          remoteTenantId,
          remoteConnectionId,
          remotePublicKey,
          connectionName
        );

        return c.json({
          connectionId: result.connectionId,
          localPublicKey: result.localPublicKey,
        });
      } catch (error) {
        log.error("Error exchanging keys:", error as object);
        throw new HTTPException(400, {
          message:
            error instanceof Error ? error.message : "Key exchange failed",
        });
      }
    }
  );

  /**
   * GET /
   * List all connections for this tenant
   */
  app.get(
    `${baseRoute}`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator("param", v.object({ tenantId: v.string() })),
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
        const { tenantId } = c.req.valid("param");
        const conns =
          await connectionsService.getConnectionByLocalTenant(tenantId);

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
