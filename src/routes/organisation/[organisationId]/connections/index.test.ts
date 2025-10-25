import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import type { FastAppHono } from "../../../../types";
import defineConnectionsRoutes from ".";
import { initTests, TEST_ORGANISATION_1 } from "../../../../test/init.test";
import log from "../../../../lib/log";

describe("Connections API Endpoints (loopback)", () => {
  const app: FastAppHono = new Hono();
  let adminJwt: string;
  let connectionId: string;
  let connectToken: string;
  let serverPublicKey: string;
  let wsKey: string;
  let baseUrl: string;
  let server: any;

  beforeAll(async () => {
    const { adminToken } = await initTests();
    adminJwt = adminToken;
    defineConnectionsRoutes(app, "/api");
    server = Bun.serve({
      port: 0,
      fetch: (req, server) => app.fetch(req, server),
      websocket: {
        // required by Bun to enable upgrade support at all
        message() {},
        open() {},
        close() {},
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  it("should init a new connection and return connect token", async () => {
    const res = await fetch(
      baseUrl + 
        "/api/organisation/" +
        TEST_ORGANISATION_1.id +
        "/connections/init",
      {
        method: "POST",
        headers: { Cookie: `jwt=${adminJwt}` },
        body: JSON.stringify({ name: "loop", initiatedBy: "client" }),
      }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBeDefined();
    expect(json.localPublicKey).toBeDefined();
    expect(json.meta?.connectToken).toBeDefined();
    connectionId = json.id;
    serverPublicKey = json.localPublicKey;
    connectToken = json.meta.connectToken;
  });

  it("should accept connect with client public key and return wsKey", async () => {
    const clientPublicKeyPem = "TEST-CLIENT-PUBLIC-KEY";

    const res = await fetch(
      baseUrl +
        "/api/organisation/" +
        TEST_ORGANISATION_1.id +
        "/connections/connect",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId,
          connectToken,
          clientPublicKey: clientPublicKeyPem,
        }),
        headers: { "Content-Type": "application/json" },
      }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.wsKey).toBeDefined();
    wsKey = json.wsKey;
  });

});
