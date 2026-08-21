/**
 * Mounting of framework-managed MCP servers (see ./types.ts for the config).
 *
 * For every entry in `defineServer({ mcpServers })` this registers, at the
 * DOMAIN ROOT (deliberately not under `basePath` — discovery documents live
 * at the origin root per RFC 9728):
 *
 *   - `ALL <path>`            the MCP endpoint itself (auth + protocol)
 *   - `GET /.well-known/oauth-protected-resource<path>`  the RFC 9728
 *     protected-resource metadata (plus the un-suffixed root variant for the
 *     first server), pointing clients at this app as the authorization server
 *   - permissive CORS on those paths: MCP clients are cross-origin web apps
 *     (claude.ai), and the `WWW-Authenticate` header must be exposed or a
 *     client never learns where to sign in
 *
 * Must be registered BEFORE the framework's global CORS middleware: hono's
 * cors() short-circuits OPTIONS preflights, so the first matching middleware
 * decides — and for the MCP paths that has to be the permissive one.
 */
import type { Hono } from "hono";
import { cors } from "hono/cors";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import log from "../log";
import { authenticateMcpRequest, type McpAuthInfo } from "./auth";
import { handleMcpRequest } from "./protocol";
import type { McpRequestContext, McpServerDefinition } from "./types";

export type { McpAuthInfo } from "./auth";
export { authenticateMcpRequest } from "./auth";
export { handleMcpRequest } from "./protocol";
export * from "./types";

const PRM_PATH = "/.well-known/oauth-protected-resource";

const baseUrl = () => _GLOBAL_SERVER_CONFIG.baseUrl.replace(/\/$/, "");

const issuerUrl = () =>
  (
    _GLOBAL_SERVER_CONFIG.oauth2?.issuer || _GLOBAL_SERVER_CONFIG.baseUrl
  ).replace(/\/$/, "");

const normalizePath = (path: string | undefined): string => {
  const p = (path ?? "/mcp").trim();
  if (!p.startsWith("/")) return `/${p}`;
  return p.replace(/\/$/, "") || "/mcp";
};

/**
 * The request context handed to resolvers and tool handlers. `fetchApi`
 * dispatches against this very Hono app — an in-process call, no network —
 * forwarding the caller's credential so every route-level permission check
 * applies exactly as if the user called the API directly.
 */
const buildContext = (
  app: Hono<any>,
  auth: McpAuthInfo
): McpRequestContext => ({
  usersId: auth.usersId,
  usersEmail: auth.usersEmail,
  tenantId: auth.tenantId,
  scopes: auth.scopes,
  tokenKind: auth.tokenKind,
  fetchApi: (path, init) => {
    const headers = new Headers(init?.headers);
    if (auth.header === "x-api-key") {
      headers.set("x-api-key", auth.token);
    } else {
      headers.set("authorization", `Bearer ${auth.token}`);
    }
    return Promise.resolve(app.request(path, { ...init, headers }));
  },
});

/** Register all configured MCP servers on the root app. */
export function defineMcpRoutes(
  app: Hono<any>,
  servers: McpServerDefinition[] | undefined
): void {
  if (!servers || servers.length === 0) return;

  const seen = new Set<string>();
  servers.forEach((server, index) => {
    const path = normalizePath(server.path);
    if (seen.has(path)) {
      throw new Error(`Duplicate MCP server path: ${path}`);
    }
    seen.add(path);

    const resourceUrl = () => `${baseUrl()}${path}`;
    const prmPath = `${PRM_PATH}${path}`;

    const mcpCors = cors({
      origin: "*",
      allowHeaders: [
        "authorization",
        "x-api-key",
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
      ],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      exposeHeaders: [
        "WWW-Authenticate",
        "mcp-session-id",
        "mcp-protocol-version",
      ],
    });
    app.use(path, mcpCors);
    app.use(prmPath, mcpCors);

    // RFC 9728 protected-resource metadata. Clients derive the path-suffixed
    // variant from the resource URL; the root variant answers for the first
    // server so origin-level probes work too.
    const metadata = (c: any) =>
      c.json({
        resource: resourceUrl(),
        authorization_servers: [issuerUrl()],
        scopes_supported: server.scopesSupported ?? [],
        bearer_methods_supported: ["header"],
      });
    app.get(prmPath, metadata);
    if (index === 0) {
      app.use(PRM_PATH, mcpCors);
      app.get(PRM_PATH, metadata);
    }

    app.all(path, async (c) => {
      const auth = await authenticateMcpRequest(c.req.raw, resourceUrl());
      if (!auth) {
        return c.json(
          {
            error: "unauthorized",
            error_description: `Authenticate with an OAuth2 access token or an API token. Resource metadata: ${baseUrl()}${prmPath}`,
          },
          401,
          {
            "WWW-Authenticate": `Bearer resource_metadata="${baseUrl()}${prmPath}"`,
          }
        );
      }
      return handleMcpRequest(server, buildContext(app, auth), c.req.raw);
    });

    log.debug(`MCP server "${server.name}" mounted at ${path}`);
  });
}
