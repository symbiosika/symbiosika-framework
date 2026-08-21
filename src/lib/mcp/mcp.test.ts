/**
 * End-to-end tests for the framework-mounted MCP server: discovery, auth
 * (session JWT + API token), the stateless JSON protocol, DYNAMIC tools and
 * instructions (resolved per request from the auth context), argument
 * validation and the in-process `fetchApi`.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import * as v from "valibot";
import {
  initTests,
  TEST_ORG1_USER_1,
  TEST_ORGANISATION_1,
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { users } from "../db/db-schema";
import { eq } from "drizzle-orm";
import { generateUserSessionJwt } from "../auth";
import { createApiToken } from "../auth/token-auth";
import { defineMcpRoutes } from "./index";
import type { McpServerDefinition, McpToolDefinition } from "./types";

let sessionJwt = "";
let apiToken = "";

const echoTool: McpToolDefinition = {
  name: "echo",
  description: "Echoes the message back.",
  inputSchema: v.object({
    message: v.string(),
    times: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  }),
  handler: async (args) => ({
    echoed: args.message,
    times: args.times ?? 1,
  }),
};

const whoamiTool: McpToolDefinition = {
  name: "whoami_ctx",
  description: "Returns the auth context the tool sees.",
  handler: async (_args, ctx) => ({
    usersId: ctx.usersId,
    usersEmail: ctx.usersEmail,
    tenantId: ctx.tenantId ?? null,
    tokenKind: ctx.tokenKind,
  }),
};

const apiTokenOnlyTool: McpToolDefinition = {
  name: "api_token_only",
  description: "Visible only to API-token callers.",
  handler: async () => "secret",
};

const fetchApiTool: McpToolDefinition = {
  name: "call_own_api",
  description: "Calls a route of this very app in-process.",
  handler: async (_args, ctx) => {
    const res = await ctx.fetchApi("/internal/echo-auth");
    return { status: res.status, body: await res.json() };
  },
};

const serverDef: McpServerDefinition = {
  name: "test-mcp",
  version: "0.0.1",
  scopesSupported: ["user:read"],
  // Dynamic instructions: resolved per request from the auth context.
  instructions: async (ctx) => `Hello ${ctx.usersEmail ?? "unknown"}!`,
  // Dynamic tools: API-token callers see one tool more.
  tools: async (ctx) => {
    const base = [echoTool, whoamiTool, fetchApiTool];
    return ctx.tokenKind === "api-token" ? [...base, apiTokenOnlyTool] : base;
  },
  resources: [
    {
      uri: "ui://test/panel.html",
      name: "panel",
      mimeType: "text/html",
      read: async (ctx) => ({ text: `<b>${ctx.usersId}</b>` }),
    },
  ],
};

const app = new Hono();
defineMcpRoutes(app as any, [serverDef]);
// A fake API route so `fetchApi` has something in-process to call.
app.get("/internal/echo-auth", (c) =>
  c.json({
    authorization: c.req.header("authorization") ?? null,
    apiKey: c.req.header("x-api-key") ?? null,
  })
);

const rpc = async (
  token: string | undefined,
  body: unknown,
  headers: Record<string, string> = {}
) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* 202s have no body */
  }
  return { status: res.status, json };
};

beforeAll(async () => {
  await initTests();
  const user = await getDb()
    .select()
    .from(users)
    .where(eq(users.email, TEST_ORG1_USER_1.email));
  const session = await generateUserSessionJwt(user[0]!);
  sessionJwt = session.token;
  const created = await createApiToken({
    name: "mcp-test-token",
    userId: user[0]!.id,
    tenantId: TEST_ORGANISATION_1.id,
    scopes: ["user:read"],
  });
  apiToken = created.token;
});

describe("MCP discovery + auth", () => {
  test("serves protected-resource metadata at the root well-known", async () => {
    const res = await app.request(
      "/.well-known/oauth-protected-resource/mcp"
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as any;
    expect(meta.resource.endsWith("/mcp")).toBe(true);
    expect(Array.isArray(meta.authorization_servers)).toBe(true);
    expect(meta.scopes_supported).toEqual(["user:read"]);

    const root = await app.request("/.well-known/oauth-protected-resource");
    expect(root.status).toBe(200);
  });

  test("answers 401 with a WWW-Authenticate pointer when unauthenticated", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate") ?? "").toContain(
      "resource_metadata="
    );
  });

  test("rejects garbage bearer tokens", async () => {
    const { status } = await rpc("not.a.jwt", {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(status).toBe(401);
  });

  test("GET is 405 (stateless server, no SSE stream)", async () => {
    const res = await app.request("/mcp", {
      method: "GET",
      headers: { authorization: `Bearer ${sessionJwt}` },
    });
    expect(res.status).toBe(405);
  });
});

describe("MCP protocol", () => {
  test("initialize returns serverInfo and per-user dynamic instructions", async () => {
    const { status, json } = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(status).toBe(200);
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.serverInfo.name).toBe("test-mcp");
    expect(json.result.instructions).toBe(
      `Hello ${TEST_ORG1_USER_1.email}!`
    );
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.capabilities.resources).toBeDefined();
  });

  test("negotiates down an unknown protocol version", async () => {
    const { json } = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "9999-01-01" },
    });
    expect(json.result.protocolVersion).toBe("2025-06-18");
  });

  test("notifications get a bodyless 202", async () => {
    const { status } = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(status).toBe(202);
  });

  test("tools/list is dynamic per caller: session JWT vs API token", async () => {
    const viaJwt = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const jwtNames = viaJwt.json.result.tools.map((t: any) => t.name);
    expect(jwtNames).toContain("echo");
    expect(jwtNames).not.toContain("api_token_only");
    // Input schema converted to JSON Schema on the wire.
    const echo = viaJwt.json.result.tools.find((t: any) => t.name === "echo");
    expect(echo.inputSchema.type).toBe("object");
    expect(echo.inputSchema.properties.message.type).toBe("string");

    const viaApi = await rpc(apiToken, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    const apiNames = viaApi.json.result.tools.map((t: any) => t.name);
    expect(apiNames).toContain("api_token_only");
  });

  test("a tool hidden from the caller cannot be called either", async () => {
    const { json } = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "api_token_only", arguments: {} },
    });
    expect(json.error.code).toBe(-32602);
  });

  test("tools/call validates arguments against the valibot schema", async () => {
    const bad = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "echo", arguments: { times: 2 } },
    });
    expect(bad.json.result.isError).toBe(true);
    expect(bad.json.result.content[0].text).toContain("message");

    const good = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hi", times: 2 } },
    });
    expect(good.json.result.isError).toBeUndefined();
    expect(good.json.result.structuredContent).toEqual({
      echoed: "hi",
      times: 2,
    });
  });

  test("tool context carries the API token's tenant binding", async () => {
    const { json } = await rpc(apiToken, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "whoami_ctx", arguments: {} },
    });
    expect(json.result.structuredContent.tenantId).toBe(
      TEST_ORGANISATION_1.id
    );
    expect(json.result.structuredContent.tokenKind).toBe("api-token");
    expect(json.result.structuredContent.usersEmail).toBe(
      TEST_ORG1_USER_1.email
    );
  });

  test("API token works on the X-API-KEY header too", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiToken,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }),
    });
    expect(res.status).toBe(200);
  });

  test("fetchApi calls this app in-process with the caller's credential", async () => {
    const { json } = await rpc(apiToken, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "call_own_api", arguments: {} },
    });
    const body = json.result.structuredContent;
    expect(body.status).toBe(200);
    // Raw API tokens are forwarded on X-API-KEY (the framework's Bearer slot
    // only accepts JWTs).
    expect(body.body.apiKey).toBe(apiToken);
  });

  test("resources/list + resources/read", async () => {
    const list = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      id: 10,
      method: "resources/list",
    });
    expect(list.json.result.resources[0].uri).toBe("ui://test/panel.html");

    const read = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      id: 11,
      method: "resources/read",
      params: { uri: "ui://test/panel.html" },
    });
    expect(read.json.result.contents[0].mimeType).toBe("text/html");
    expect(read.json.result.contents[0].text).toContain("<b>");
  });

  test("unknown method → -32601, unknown resource → -32002", async () => {
    const bad = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      id: 12,
      method: "prompts/list",
    });
    expect(bad.json.error.code).toBe(-32601);

    const badRes = await rpc(sessionJwt, {
      jsonrpc: "2.0",
      id: 13,
      method: "resources/read",
      params: { uri: "ui://nope" },
    });
    expect(badRes.json.error.code).toBe(-32002);
  });

  test("CORS preflight on /mcp is permissive", async () => {
    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
