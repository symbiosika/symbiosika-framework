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
 * - POST /teardown - Terminate a connection from the remote side (signed, public)
 * - POST /:connectionId/verify - Verify connection status
 * - GET / - List all connections for tenant
 * - GET /list - List connections (id, name, meta only)
 * - DELETE /self-disconnect - Terminate all locally-initiated connections (Abmelden)
 * - GET /:connectionId - Get specific connection
 * - POST /:connectionId/refresh - Refresh connection timestamp
 * - DELETE /:connectionId - Terminate a connection (notify remote + delete local)
 */

import type { SymbiosikaFrameworkHonoApp } from "../../../../types";
import { HTTPException } from "hono/http-exception";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../lib/utils/hono-middlewares";
import {
  connectionsService,
  ConnectionNotFoundError,
} from "../../../../lib/connections";
import { describeRoute } from "hono-openapi";
import { validator } from "hono-openapi";
import * as v from "valibot";
import log from "../../../../lib/log";
import { validateScope } from "../../../../lib/utils/validate-scope";
import { isTenantAdmin, isTenantMember } from "../../../tenant/index";

/**
 * Define connections routes
 */
const defineConnectionsRoutes = (app: SymbiosikaFrameworkHonoApp, basePath: string) => {
  const baseRoute = `${basePath}/tenant/:tenantId/connections`;

  /**
   * POST /validate-credentials
   * Validate remote server credentials and list tenants
   */
  app.post(
    `${baseRoute}/validate-credentials`,
    authAndSetUsersInfo,
    checkUserPermission,
    isTenantAdmin,
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
    isTenantAdmin,
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
    isTenantAdmin,
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
   * POST /request-remote-code
   * Request an OTP login code to be sent to the given email on the remote server.
   */
  app.post(
    `${baseRoute}/request-remote-code`,
    authAndSetUsersInfo,
    checkUserPermission,
    isTenantAdmin,
    validator(
      "json",
      v.object({
        remoteUrl: v.string("Remote URL is required"),
        email: v.string("Email is required"),
      })
    ),
    validateScope("connections:write"),
    async (c) => {
      try {
        const { remoteUrl, email } = c.req.valid("json");
        await connectionsService.requestRemoteLoginCode(remoteUrl, email);
        return c.json({ ok: true });
      } catch (error) {
        log.error("Error requesting remote login code:", error as object);
        throw new HTTPException(400, {
          message: error instanceof Error ? error.message : "Failed to request code",
        });
      }
    }
  );

  /**
   * POST /validate-credentials-with-code
   * Verify an OTP code against the remote server and return the available tenants.
   * Returns the remote JWT token for use in init-with-token.
   */
  app.post(
    `${baseRoute}/validate-credentials-with-code`,
    authAndSetUsersInfo,
    checkUserPermission,
    isTenantAdmin,
    validator(
      "json",
      v.object({
        remoteUrl: v.string("Remote URL is required"),
        email: v.string("Email is required"),
        code: v.string("Code is required"),
      })
    ),
    validateScope("connections:write"),
    async (c) => {
      try {
        const { remoteUrl, email, code } = c.req.valid("json");
        const result = await connectionsService.validateRemoteCredentialsWithCode(remoteUrl, email, code);
        return c.json({ token: result.token, tenants: result.tenants });
      } catch (error) {
        log.error("Error validating remote code:", error as object);
        throw new HTTPException(400, {
          message: error instanceof Error ? error.message : "Code validation failed",
        });
      }
    }
  );

  /**
   * POST /init-with-token
   * Initialize a connection using a pre-obtained remote JWT token (from OTP flow).
   */
  app.post(
    `${baseRoute}/init-with-token`,
    authAndSetUsersInfo,
    checkUserPermission,
    isTenantAdmin,
    validator(
      "json",
      v.object({
        remoteUrl: v.string("Remote URL is required"),
        remoteToken: v.string("Remote token is required"),
        remoteTenantId: v.string("Remote tenant ID is required"),
        remoteTenantName: v.string("Remote tenant name is required"),
        name: v.string("Connection name is required"),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    validateScope("connections:write"),
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const { remoteUrl, remoteToken, remoteTenantId, remoteTenantName, name } = c.req.valid("json");
        const result = await connectionsService.initializeConnectionWithToken(
          tenantId,
          remoteUrl,
          remoteToken,
          remoteTenantId,
          remoteTenantName,
          name
        );
        return c.json(result, 201);
      } catch (error) {
        log.error("Error initializing connection with token:", error as object);
        throw new HTTPException(400, {
          message: error instanceof Error ? error.message : "Connection failed",
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
        // Explicit, machine-readable signal that the connection no longer
        // exists here. The remote uses this to self-heal (delete its own row)
        // — distinct from a 401 invalid-signature, which must NOT delete it.
        if (error instanceof ConnectionNotFoundError) {
          return c.json(
            { error: "connection_not_found", message: error.message },
            404
          );
        }
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
   * POST /teardown
   * Terminate ("cancel") a connection from the remote side.
   * Public endpoint — authorized solely by the RSA signature over
   * `${remoteConnectionId}:${timestamp}`, verified against the stored public
   * key (same trust model as /authenticate). Idempotent.
   */
  app.post(
    `${baseRoute}/teardown`,
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
      description: "Terminate a connection from the remote side (signed request)",
      responses: {
        200: { description: "Connection torn down (or already gone)" },
        401: { description: "Invalid signature" },
      },
    }),
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const { remoteConnectionId, timestamp, signature } =
          c.req.valid("json");

        const result = await connectionsService.teardownConnectionBySignature(
          tenantId,
          remoteConnectionId,
          timestamp,
          signature
        );

        return c.json(result);
      } catch (error) {
        log.error("Error tearing down connection:", error as object);
        throw new HTTPException(401, {
          message:
            error instanceof Error ? error.message : "Teardown failed",
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
    isTenantMember,
    validator(
      "param",
      v.object({ tenantId: v.string(), connectionId: v.string() })
    ),
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
        const { tenantId, connectionId } = c.req.valid("param");

        const result = await connectionsService.verifyConnection(
          connectionId,
          tenantId
        );

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
    isTenantMember,
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
   * Query params: initiatedBy (optional) - filter by "local" or "remote"
   */
  app.get(
    `${baseRoute}/list`,
    authAndSetUsersInfo,
    checkUserPermission,
    isTenantMember,
    validator("param", v.object({ tenantId: v.string() })),
    validator(
      "query",
      v.object({
        initiatedBy: v.optional(v.picklist(["local", "remote"])),
      })
    ),
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
        const { initiatedBy } = c.req.valid("query");
        const conns =
          await connectionsService.getConnectionByLocalTenant(tenantId, initiatedBy);

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
   * DELETE /self-disconnect
   * Terminate all connections this tenant initiated locally (the "Abmelden"
   * action). Notifies each remote, then deletes locally. Registered before the
   * /:connectionId routes so "self-disconnect" is not parsed as a connection id.
   */
  app.delete(
    `${baseRoute}/self-disconnect`,
    authAndSetUsersInfo,
    checkUserPermission,
    isTenantAdmin,
    validator("param", v.object({ tenantId: v.string() })),
    validateScope("connections:write"),
    describeRoute({
      description: "Terminate all locally-initiated connections of this tenant",
      responses: {
        200: { description: "Connections terminated successfully" },
        400: { description: "Failed to terminate connections" },
      },
    }),
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const result =
          await connectionsService.disconnectLocalConnections(tenantId);
        return c.json({
          message: "Disconnected successfully",
          ...result,
        });
      } catch (error) {
        log.error("Error self-disconnecting:", error as object);
        throw new HTTPException(400, {
          message:
            error instanceof Error ? error.message : "Failed to disconnect",
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
    isTenantMember,
    validator(
      "param",
      v.object({ tenantId: v.string(), connectionId: v.string() })
    ),
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
        const { tenantId, connectionId } = c.req.valid("param");
        const connection = await connectionsService.getConnection(
          connectionId,
          tenantId
        );

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
    isTenantAdmin,
    validator(
      "param",
      v.object({ tenantId: v.string(), connectionId: v.string() })
    ),
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
        const { tenantId, connectionId } = c.req.valid("param");
        await connectionsService.refreshConnection(connectionId, tenantId);

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
    isTenantAdmin,
    validator(
      "param",
      v.object({ tenantId: v.string(), connectionId: v.string() })
    ),
    validateScope("connections:write"),
    describeRoute({
      description:
        "Terminate a connection: notify the remote (best-effort), then delete locally",
      responses: {
        200: {
          description: "Connection terminated successfully",
        },
        400: {
          description: "Failed to terminate connection",
        },
      },
    }),
    async (c) => {
      try {
        const { tenantId, connectionId } = c.req.valid("param");
        const result = await connectionsService.disconnectConnection(
          connectionId,
          tenantId
        );

        return c.json({
          message: "Connection terminated successfully",
          ...result,
        });
      } catch (error) {
        log.error("Error terminating connection:", error as object);
        throw new HTTPException(400, {
          message:
            error instanceof Error
              ? error.message
              : "Failed to terminate connection",
        });
      }
    }
  );
};

export default defineConnectionsRoutes;
