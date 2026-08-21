# Built-in MCP Server Support

The framework can host one or more **MCP servers** (Model Context Protocol,
Streamable HTTP) directly inside the app — no separate resource-server
process, no token introspection round-trips, no shared secrets. Declare them
in `defineServer()`:

```ts
import { defineServer } from "@framework/index";
import type { McpServerDefinition } from "@framework/types";
import * as v from "valibot";

const myMcpServer: McpServerDefinition = {
  path: "/mcp",                       // mounted at the DOMAIN ROOT (not basePath)
  name: "my-app-mcp",
  version: "1.0.0",
  scopesSupported: ["user:read", "files:read"],

  // May be a plain string — or a resolver, e.g. per-tenant from the DB:
  instructions: async (ctx) => loadInstructionsForTenant(ctx.tenantId),

  // May be a plain array — or a resolver, e.g. filtered by user permissions:
  tools: async (ctx) => {
    const allowed = await toolsAllowedFor(ctx.usersId, ctx.tenantId);
    return ALL_TOOLS.filter((t) => allowed.has(t.name));
  },
};

defineServer({
  // …
  oauth2: { enabled: true /* … */ },  // recommended: lets claude.ai sign in
  mcpServers: [myMcpServer],
});
```

## What the framework does

For every entry in `mcpServers` it registers, at the domain root:

- `ALL <path>` — the MCP endpoint (default `/mcp`). Stateless Streamable
  HTTP with JSON responses; `initialize`, `ping`, `tools/list`, `tools/call`,
  `resources/list`, `resources/read` are served, notifications answer `202`,
  `GET`/`DELETE` answer `405`.
- `GET /.well-known/oauth-protected-resource[<path>]` — RFC 9728 discovery,
  pointing clients at this app as the authorization server.
- Permissive CORS on those paths (MCP clients are cross-origin web apps, and
  `WWW-Authenticate` must be exposed for the sign-in flow to start).

## Authentication

Requests are validated in-process — the app **is** the authorization server:

1. **OAuth2 access tokens** (`Authorization: Bearer`) — verified with the
   framework key, plus an RFC 8707 audience check: a token minted for another
   resource is rejected. Requires `oauth2.enabled`. The tenant chosen at
   sign-in arrives as `ctx.tenantId`.
2. **API tokens** (`X-API-KEY`, or a non-JWT Bearer for single-field hosts) —
   the framework's long-lived, revocable, tenant-bound tokens.
3. **Session JWTs** — accepted too (server-side session is enforced), handy
   for local testing.

Unauthenticated requests get `401` with a `WWW-Authenticate` header pointing
at the protected-resource metadata — exactly what claude.ai needs to start
the OAuth flow. Make sure `oauth2.dcrDefaultScopes` covers every scope in
`scopesSupported`, or dynamically registered clients fail at authorize.

## Dynamic by design

`instructions`, `tools` and `resources` each accept **either a value or a
resolver function** over the authenticated request context:

```ts
type McpRequestContext = {
  usersId: string;
  usersEmail?: string;
  tenantId?: string;                 // OAuth sign-in choice or API-token binding
  scopes: string[];
  tokenKind: "oauth" | "api-token" | "session";
  fetchApi: (path, init?) => Promise<Response>;  // in-process, as the caller
};
```

Resolvers run on **every request** (the transport is stateless), so per-tenant
instructions from the database and permission-dependent tool lists are simply
what falls out: a user only ever sees — and can only call — what the resolver
returns for them. Keep resolvers cheap or cache inside them.

## Tools

```ts
const tool: McpToolDefinition = {
  name: "list_things",
  description: "…",
  inputSchema: v.object({            // valibot → JSON Schema + validation
    limit: v.optional(v.pipe(v.number(), v.integer(), v.maxValue(100))),
  }),
  handler: async (args, ctx) => {
    // Recommended: go through the app's own HTTP API so every route-level
    // permission check applies. In-process, no network.
    const res = await ctx.fetchApi(`/api/v1/tenant/${ctx.tenantId}/things`);
    return await res.json();         // plain values are normalised for MCP
  },
};
```

- `inputSchema` is a **valibot** schema (arguments are validated; failures
  become friendly error results) or a raw JSON-Schema object (passed through,
  not validated).
- Handlers may return a full MCP result (`{ content: […] }`), a string, or a
  plain object/array (serialised to text + `structuredContent`).
- Thrown errors become error *results*, keeping the model in the conversation.
- `_meta` supports MCP-Apps linkage (`ui.resourceUri`); ship the HTML views
  as `resources`.

## Notes

- The endpoint lives at the domain root on purpose: discovery documents are
  origin-scoped. The tools still call the API under `basePath`.
- Multiple servers are allowed (distinct `path`s); the first one also answers
  the un-suffixed `/.well-known/oauth-protected-resource`.
- The implementation is SDK-free (see `src/lib/mcp/`): consumers are not
  pinned to any MCP SDK version; apps may still use SDKs for their own view
  bundles (e.g. `@modelcontextprotocol/ext-apps`).
