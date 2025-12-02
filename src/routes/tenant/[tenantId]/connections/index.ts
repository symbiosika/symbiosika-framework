/**
 * Connections API Routes
 * 
 * Manages server-to-server connections with cryptographic key exchange
 * 
 * Endpoints:
 * - POST /validate-credentials - Validate remote server credentials
 * - POST /init - Initialize a new connection to a remote server
 * - POST /exchange-keys - Accept connection from remote server (called by remote)
 * - POST /authenticate - Authenticate connection using signature (public endpoint)
 * - POST /:connectionId/verify - Verify connection status
 * - GET / - List all connections for tenant
 * - GET /list - List connections (id, name, meta only)
 * - GET /:connectionId - Get specific connection
 * - POST /:connectionId/refresh - Refresh connection timestamp
 * - DELETE /:connectionId - Drop a connection
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
      description: "Validate remote server credentials and list available tenants",
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
          message:
            error instanceof Error ? error.message : "Validation failed",
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
        const {
          remoteUrl,
          remoteEmail,
          remotePassword,
          remoteTenantId,
          name,
        } = c.req.valid("json");

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
          message:
            error instanceof Error ? error.message : "Connection failed",
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
        remoteTenantName: v.string("Remote tenant name is required"),
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
          remoteTenantName,
          remoteUrl,
          connectionName,
        } = c.req.valid("json");

        log.info(
          `exchange-keys endpoint called: tenantId=${tenantId}, remoteTenantId=${remoteTenantId}, remoteConnectionId=${remoteConnectionId}, connectionName=${connectionName}`
        );

        // Accept the connection and get our public key
        const result = await connectionsService.acceptConnection(
          tenantId,
          remoteUrl,
          remoteTenantId,
          remoteConnectionId,
          remotePublicKey,
          connectionName,
          remoteTenantName
        );

        log.info(
          `exchange-keys completed successfully: connectionId=${result.connectionId}`
        );

        return c.json({
          connectionId: result.connectionId,
          localPublicKey: result.localPublicKey,
          serverId: result.remoteConnectionId, // For backward compatibility
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
   * POST /authenticate
   * Authenticate connection using key signature
   * Public endpoint, signature verified by public key
   */
  app.post(
    `${baseRoute}/authenticate`,
    validator(
      "json",
      v.object({
        remoteConnectionId: v.string("Remote connection ID is required"),
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
        const { remoteConnectionId, timestamp, signature } = c.req.valid("json");

        // authenticateConnection checks signature against DB
        const result = await connectionsService.authenticateConnection(
          tenantId,
          remoteConnectionId,
          timestamp,
          signature
        );

        return c.json(result);
      } catch (error) {
        log.error("Error authenticating connection:", error as object);
        throw new HTTPException(401, {
          message:
            error instanceof Error
              ? error.message
              : "Authentication failed",
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
   * GET /list
   * List all connections for this tenant (only id, name, meta)
   */
  app.get(
    `${baseRoute}/list`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator("param", v.object({ tenantId: v.string() })),
    validateScope("connections:read"),
    describeRoute({
      description: "List all connections (id, name, meta only)",
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

        // Return only id, name, and meta fields
        const simplifiedConnections = conns.map((conn) => ({
          id: conn.id,
          name: conn.name,
          meta: conn.meta,
        }));

        return c.json({
          connections: simplifiedConnections,
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
    describeRoute({
      description: "Get a specific connection",
      responses: {
        200: {
          description: "Connection retrieved successfully",
        },
        404: {
          description: "Connection not found",
        },
      },
    }),
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
   * POST /:connectionId/refresh
   * Refresh connection - update lastConnectedAt timestamp
   */
  app.post(
    `${baseRoute}/:connectionId/refresh`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator("param", v.object({ connectionId: v.string() })),
    validateScope("connections:write"),
    describeRoute({
      description: "Refresh connection timestamp",
      responses: {
        200: {
          description: "Connection refreshed successfully",
        },
        400: {
          description: "Refresh failed",
        },
      },
    }),
    async (c) => {
      try {
        const { connectionId } = c.req.valid("param");
        await connectionsService.refreshConnection(connectionId);

        return c.json({
          message: "Connection refreshed successfully",
        });
      } catch (error) {
        log.error("Error refreshing connection:", error as object);
        throw new HTTPException(400, {
          message:
            error instanceof Error ? error.message : "Refresh failed",
        });
      }
    }
  );

  /**
   * DELETE /:connectionId
   * Drop a connection
   */
  app.delete(
    `${baseRoute}/:connectionId`,
    authAndSetUsersInfo,
    checkUserPermission,
    validator("param", v.object({ connectionId: v.string() })),
    validateScope("connections:write"),
    describeRoute({
      description: "Drop a connection",
      responses: {
        200: {
          description: "Connection dropped successfully",
        },
        400: {
          description: "Failed to drop connection",
        },
      },
    }),
    async (c) => {
      try {
        const { connectionId } = c.req.valid("param");
        await connectionsService.dropConnection(connectionId);

        return c.json({
          message: "Connection dropped successfully",
        });
      } catch (error) {
        log.error("Error dropping connection:", error as object);
        throw new HTTPException(400, {
          message:
            error instanceof Error ? error.message : "Failed to drop connection",
        });
      }
    }
  );
};

export default defineConnectionsRoutes;
