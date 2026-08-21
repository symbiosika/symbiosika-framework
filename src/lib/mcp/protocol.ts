/**
 * A stateless MCP server over Streamable HTTP with JSON responses.
 *
 * Implemented directly on the wire format (JSON-RPC 2.0) rather than through
 * an SDK, for two reasons: the official server SDK is still in alpha and
 * would pin every consumer of this framework to its churn, and — more
 * importantly — this server's tool list, resources and instructions are
 * *dynamic per request* (they may depend on the calling user's permissions
 * and tenant), which maps naturally onto "resolve, then answer" and awkwardly
 * onto an SDK designed around a static registration phase.
 *
 * Stateless by design: no session ids are issued, every POST is answered with
 * a plain JSON body (the spec explicitly allows a server to respond with
 * `application/json` instead of an SSE stream), GET/DELETE answer 405. That
 * is the same mode the `WebStandardStreamableHTTPServerTransport` runs in
 * when configured without a session-id generator.
 */
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import type {
  McpRequestContext,
  McpSchema,
  McpServerDefinition,
  McpToolDefinition,
  McpToolResult,
} from "./types";

/** Newest first; `initialize` echoes the client's version when supported. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

const JSON_HEADERS = { "content-type": "application/json" };

const rpcResult = (id: string | number | null, result: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  result,
});

const rpcError = (
  id: string | number | null,
  code: number,
  message: string
) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });

const isValibotSchema = (schema: McpSchema): schema is v.GenericSchema<any> =>
  typeof schema === "object" &&
  schema !== null &&
  (schema as any).kind === "schema" &&
  typeof (schema as any)["~run"] === "function";

/** JSON Schema for the wire: convert valibot, pass raw JSON Schema through. */
const wireSchema = (schema: McpSchema | undefined): Record<string, unknown> => {
  if (!schema) return { type: "object", properties: {} };
  if (isValibotSchema(schema)) {
    return toJsonSchema(schema, { errorMode: "ignore" }) as Record<
      string,
      unknown
    >;
  }
  return schema;
};

/** Wrap arrays (MCP requires `structuredContent` to be an object). */
const asStructured = (data: unknown): Record<string, unknown> | undefined => {
  if (data === null || typeof data !== "object") return undefined;
  return Array.isArray(data)
    ? { items: data }
    : (data as Record<string, unknown>);
};

/** Normalise whatever a handler returned into a full tool result. */
const normalizeToolResult = (value: unknown): McpToolResult => {
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] };
  }
  if (value && typeof value === "object" && Array.isArray((value as any).content)) {
    return value as McpToolResult;
  }
  const structured = asStructured(value);
  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
    ...(structured ? { structuredContent: structured } : {}),
  };
};

const errorResult = (message: string): McpToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

const resolveDynamic = async <T>(
  value: T | ((ctx: McpRequestContext) => T | Promise<T>) | undefined,
  ctx: McpRequestContext,
  fallback: T
): Promise<T> => {
  if (value === undefined) return fallback;
  if (typeof value === "function") {
    return await (value as (ctx: McpRequestContext) => T | Promise<T>)(ctx);
  }
  return value;
};

const toolToWire = (tool: McpToolDefinition) => ({
  name: tool.name,
  ...(tool.title ? { title: tool.title } : {}),
  description: tool.description,
  inputSchema: wireSchema(tool.inputSchema),
  ...(tool.outputSchema ? { outputSchema: wireSchema(tool.outputSchema) } : {}),
  ...(tool.annotations ? { annotations: tool.annotations } : {}),
  ...(tool._meta ? { _meta: tool._meta } : {}),
});

/** Handle one JSON-RPC request message; returns null for notifications. */
const handleMessage = async (
  server: McpServerDefinition,
  ctx: McpRequestContext,
  msg: JsonRpcMessage
): Promise<JsonRpcMessage | null> => {
  const { method, params } = msg;
  // Notifications (no id) — including responses a client might relay — are
  // accepted and produce no body.
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  if (!method || typeof method !== "string") {
    return isNotification ? null : rpcError(id, -32600, "Invalid request");
  }
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      const instructions = await resolveDynamic(server.instructions, ctx, "");
      return rpcResult(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          ...(server.resources ? { resources: { listChanged: false } } : {}),
        },
        serverInfo: {
          name: server.name,
          ...(server.title ? { title: server.title } : {}),
          version: server.version ?? "1.0.0",
        },
        ...(instructions ? { instructions } : {}),
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list": {
      const tools = await resolveDynamic(server.tools, ctx, []);
      return rpcResult(id, { tools: tools.map(toolToWire) });
    }

    case "tools/call": {
      const name = params?.name;
      const tools = await resolveDynamic(server.tools, ctx, []);
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      }
      let args = params?.arguments ?? {};
      if (tool.inputSchema && isValibotSchema(tool.inputSchema)) {
        const parsed = v.safeParse(tool.inputSchema, args);
        if (!parsed.success) {
          const issues = parsed.issues
            .map((i) => `${v.getDotPath(i) || "input"}: ${i.message}`)
            .join("; ");
          return rpcResult(
            id,
            errorResult(`Invalid arguments for ${tool.name} — ${issues}`)
          );
        }
        args = parsed.output;
      }
      try {
        const result = await tool.handler(args, ctx);
        return rpcResult(id, normalizeToolResult(result));
      } catch (error) {
        // A thrown error becomes an error *result*: the model stays in the
        // conversation and can react, instead of hitting a protocol error.
        return rpcResult(
          id,
          errorResult((error as Error).message || String(error))
        );
      }
    }

    case "resources/list": {
      const resources = await resolveDynamic(server.resources, ctx, []);
      return rpcResult(id, {
        resources: resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          ...(r.title ? { title: r.title } : {}),
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
          ...(r._meta ? { _meta: r._meta } : {}),
        })),
      });
    }

    case "resources/templates/list":
      return rpcResult(id, { resourceTemplates: [] });

    case "resources/read": {
      const uri = params?.uri;
      const resources = await resolveDynamic(server.resources, ctx, []);
      const resource = resources.find((r) => r.uri === uri);
      if (!resource) {
        return rpcError(id, -32002, `Resource not found: ${String(uri)}`);
      }
      try {
        const contents = await resource.read(ctx);
        const list = Array.isArray(contents) ? contents : [contents];
        return rpcResult(id, {
          contents: list.map((c) => ({
            uri: c.uri ?? resource.uri,
            mimeType: c.mimeType ?? resource.mimeType,
            ...(c.text !== undefined ? { text: c.text } : {}),
            ...(c.blob !== undefined ? { blob: c.blob } : {}),
            ...(c._meta ? { _meta: c._meta } : {}),
          })),
        });
      } catch (error) {
        return rpcError(
          id,
          -32603,
          `Reading ${resource.uri} failed: ${(error as Error).message}`
        );
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
};

/**
 * Handle one HTTP request against an MCP endpoint. The caller has already
 * authenticated the request and built the context.
 */
export const handleMcpRequest = async (
  server: McpServerDefinition,
  ctx: McpRequestContext,
  req: Request
): Promise<Response> => {
  if (req.method !== "POST") {
    // Stateless: no SSE stream to offer on GET, no session to DELETE.
    return new Response(
      JSON.stringify(rpcError(null, -32000, "Method not allowed")),
      { status: 405, headers: { ...JSON_HEADERS, allow: "POST" } }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify(rpcError(null, -32700, "Parse error: invalid JSON")),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // Batches were part of the protocol until 2025-03-26; answering them keeps
  // older clients working and costs nothing.
  const messages: JsonRpcMessage[] = Array.isArray(body)
    ? (body as JsonRpcMessage[])
    : [body as JsonRpcMessage];
  if (messages.length === 0) {
    return new Response(
      JSON.stringify(rpcError(null, -32600, "Invalid request: empty batch")),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const responses: JsonRpcMessage[] = [];
  for (const msg of messages) {
    const response = await handleMessage(server, ctx, msg);
    if (response) responses.push(response);
  }

  // Only notifications → 202 Accepted with no body, per spec.
  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }
  const payload = Array.isArray(body) ? responses : responses[0];
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: JSON_HEADERS,
  });
};
