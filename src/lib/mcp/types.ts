/**
 * Types for the framework's built-in MCP server support.
 *
 * A consumer declares one or more MCP servers in `defineServer({ mcpServers })`
 * and the framework does the rest: mounting the endpoint at the domain root,
 * OAuth2/API-token authentication, RFC 9728 discovery, CORS, and the
 * Streamable-HTTP JSON-RPC protocol.
 *
 * Everything user-facing is allowed to be DYNAMIC: `instructions`, `tools` and
 * `resources` each accept a resolver function that receives the authenticated
 * request context — so instructions can come from a tenant's database row and
 * the tool list can depend on the calling user's permissions. Resolvers run on
 * every request (the transport is stateless), so keep them cheap or cache
 * inside them.
 */
import type * as v from "valibot";

/** How the caller authenticated at the MCP endpoint. */
export type McpTokenKind = "oauth" | "api-token" | "session";

/**
 * The authenticated context handed to instructions/tools/resources resolvers
 * and to every tool handler.
 */
export type McpRequestContext = {
  usersId: string;
  usersEmail?: string;
  /**
   * The organisation the credential is bound to: the tenant chosen at OAuth
   * sign-in, or the tenant an API token was minted for. May be undefined for
   * plain session JWTs.
   */
  tenantId?: string;
  scopes: string[];
  tokenKind: McpTokenKind;
  /**
   * In-process request against this server's own HTTP API, authenticated as
   * the calling user (the presented credential is forwarded on the header it
   * arrived on). Paths are root-relative, e.g. `/api/v1/tenant/<id>/files`.
   * No network round-trip is involved.
   */
  fetchApi: (path: string, init?: RequestInit) => Promise<Response>;
};

/**
 * An input/output schema: either a valibot schema (converted to JSON Schema
 * for the wire and used to validate arguments) or a plain JSON-Schema object
 * (passed through as-is; arguments are then NOT validated by the framework).
 */
export type McpSchema = v.GenericSchema<any, any> | Record<string, unknown>;

/** One content block of a tool result (text, image, resource, …). */
export type McpContentBlock = { type: string } & Record<string, unknown>;

/** A fully-formed MCP tool result. */
export type McpToolResult = {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

/**
 * What a tool handler may return. Anything that is not already a
 * `McpToolResult` is normalised: a string becomes a text block; a plain
 * object/array becomes pretty-printed JSON text plus `structuredContent`
 * (arrays are wrapped in `{ items }` because MCP requires an object there).
 */
export type McpToolHandlerReturn =
  | McpToolResult
  | string
  | Record<string, unknown>
  | unknown[];

export type McpToolDefinition = {
  /** Wire name, e.g. `generate_image`. Must be unique within the server. */
  name: string;
  /** Human-readable display name. */
  title?: string;
  description: string;
  /** Argument schema. Omit for tools that take no arguments. */
  inputSchema?: McpSchema;
  outputSchema?: McpSchema;
  /** MCP tool annotations (readOnlyHint, destructiveHint, …). */
  annotations?: Record<string, unknown>;
  /** Extra tool metadata, e.g. the MCP-Apps `ui.resourceUri` linkage. */
  _meta?: Record<string, unknown>;
  handler: (
    args: any,
    ctx: McpRequestContext
  ) => Promise<McpToolHandlerReturn> | McpToolHandlerReturn;
};

/** The contents returned when a resource is read. */
export type McpResourceContents = {
  /** Defaults to the resource's own uri. */
  uri?: string;
  mimeType?: string;
  /** Text contents (mutually exclusive with `blob`). */
  text?: string;
  /** Base64-encoded binary contents. */
  blob?: string;
  _meta?: Record<string, unknown>;
};

export type McpResourceDefinition = {
  /** e.g. `ui://my-app/panel.html` */
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
  read: (
    ctx: McpRequestContext
  ) => Promise<McpResourceContents | McpResourceContents[]>;
};

/** A value that may be static or resolved per request from the auth context. */
export type McpDynamic<T> = T | ((ctx: McpRequestContext) => T | Promise<T>);

export type McpServerDefinition = {
  /**
   * Mount path, root-relative (NOT under `basePath`), default `/mcp`.
   * The canonical resource identifier becomes `<baseUrl><path>`.
   */
  path?: string;
  /** Server name reported in `serverInfo`. */
  name: string;
  title?: string;
  /** Version reported in `serverInfo`. Default "1.0.0". */
  version?: string;
  /**
   * Scopes advertised in the protected-resource metadata. Clients (claude.ai
   * among them) request exactly these at sign-in, so list every scope the
   * tools rely on — and make sure `oauth2.dcrDefaultScopes` covers them.
   */
  scopesSupported?: string[];
  /**
   * Server instructions returned from `initialize`. May be a resolver — e.g.
   * loading tenant-specific instructions from the database.
   */
  instructions?: McpDynamic<string>;
  /**
   * The tools this server exposes. May be a resolver — e.g. filtering by the
   * calling user's permissions. Resolved on every `tools/list` and
   * `tools/call`, so a user only ever sees and calls what the resolver
   * returns for them.
   */
  tools?: McpDynamic<McpToolDefinition[]>;
  /** Resources (e.g. MCP-Apps HTML views). May be a resolver, like `tools`. */
  resources?: McpDynamic<McpResourceDefinition[]>;
};
