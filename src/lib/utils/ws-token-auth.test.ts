import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { Hono } from "hono";
import type { SFContextVariables } from "../../types";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import {
  initTests,
  TEST_ORG1_USER_1,
  TEST_ORGANISATION_1,
} from "../../test/init.test";
import { createApiToken } from "../auth/token-auth";
import { authAndSetUsersInfo } from "./hono-middlewares";

/**
 * A session token in `?token=` is accepted for WebSocket handshakes only.
 *
 * Why it exists: `new WebSocket(url)` is the only way a browser opens a socket,
 * and it takes no headers — so a client that authenticates with a bearer token
 * instead of the session cookie (the SPA embedded in Microsoft Teams) cannot
 * send `Authorization` on the upgrade request.
 *
 * Why it is narrow: a token in a URL lands in proxy logs, history and
 * referrers. The `Upgrade` header cannot be set from page JavaScript, so a
 * normal API call cannot claim to be a handshake and the query parameter keeps
 * its old "service token" meaning everywhere else.
 */
const app = new Hono<{ Variables: SFContextVariables }>();
app.get("/socket", authAndSetUsersInfo, (c) =>
  c.json({ userId: c.get("usersId") })
);

const WS_HEADERS = { Upgrade: "websocket", Connection: "Upgrade" };

let sessionToken: string;
let apiToken: string;

describe("WebSocket auth via query token", () => {
  beforeAll(async () => {
    const { user1Token } = await initTests();
    sessionToken = user1Token;

    const created = await createApiToken({
      name: "ws-token-auth-test",
      userId: TEST_ORG1_USER_1.id,
      tenantId: TEST_ORGANISATION_1.id,
      scopes: ["knowledge:read"],
    });
    apiToken = created.token;
  });

  test("a session token in the query authenticates a WebSocket handshake", async () => {
    const response = await app.request(
      `/socket?token=${encodeURIComponent(sessionToken)}`,
      { headers: WS_HEADERS }
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as any).userId).toBeTruthy();
  });

  test("the same token in the query is rejected on a plain request", async () => {
    // Without the upgrade header the query parameter still means "service
    // token"; a session JWT is not one, so this must not authenticate.
    const response = await app.request(
      `/socket?token=${encodeURIComponent(sessionToken)}`
    );

    expect(response.status).toBe(401);
  });

  test("a forged token is rejected on a handshake as well", async () => {
    const response = await app.request("/socket?token=not-a-jwt", {
      headers: WS_HEADERS,
    });

    expect(response.status).toBe(401);
  });

  test("the upgrade header alone authenticates nothing", async () => {
    const response = await app.request("/socket", { headers: WS_HEADERS });

    expect(response.status).toBe(401);
  });

  test("the bearer header keeps working for handshakes", async () => {
    const response = await app.request("/socket", {
      headers: { ...WS_HEADERS, Authorization: `Bearer ${sessionToken}` },
    });

    expect(response.status).toBe(200);
  });

  test("an API token in the query keeps working on a handshake", async () => {
    // The pre-existing meaning of `?token=`: a service token, resolved against
    // the database. Sockets have always been able to use it, and the session-JWT
    // branch must not take that away — hence the shape check in front of it (an
    // API token is a nanoid and contains no dot).
    const response = await app.request(
      `/socket?token=${encodeURIComponent(apiToken)}`,
      { headers: WS_HEADERS }
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as any).userId).toBe(TEST_ORG1_USER_1.id);
  });

  test("an API token in the query keeps working without an upgrade", async () => {
    const response = await app.request(
      `/socket?token=${encodeURIComponent(apiToken)}`
    );

    expect(response.status).toBe(200);
  });
});

/**
 * A handshake started by another site must not be authenticated (CSWSH).
 *
 * The credential is irrelevant here — a foreign page cannot read our bearer
 * token, but it *can* make the browser attach our cookies to a socket it opens.
 * CORS does not cover upgrades, so this is the check that covers it.
 *
 * `app.request()` builds requests against `http://localhost`, which is therefore
 * the request's own origin in these tests.
 */
describe("WebSocket origin check", () => {
  const OWN_ORIGIN = "http://localhost";
  const originalAllowed = [..._GLOBAL_SERVER_CONFIG.allowedOrigins];
  const originalBaseUrl = _GLOBAL_SERVER_CONFIG.baseUrl;

  beforeAll(async () => {
    const { user1Token } = await initTests();
    sessionToken = user1Token;
  });

  afterEach(() => {
    _GLOBAL_SERVER_CONFIG.allowedOrigins = [...originalAllowed];
    _GLOBAL_SERVER_CONFIG.baseUrl = originalBaseUrl;
  });

  const handshake = (headers: Record<string, string>) =>
    app.request("/socket", {
      headers: { ...WS_HEADERS, Authorization: `Bearer ${sessionToken}`, ...headers },
    });

  test("a same-origin handshake is allowed", async () => {
    expect((await handshake({ Origin: OWN_ORIGIN })).status).toBe(200);
  });

  test("the same host over https is allowed (TLS-terminating proxy)", async () => {
    // The request reaches the server as plain http while the browser reports an
    // https origin. Comparing schemes would reject every real deployment.
    expect((await handshake({ Origin: "https://localhost" })).status).toBe(200);
  });

  test("a lookalike host is still rejected", async () => {
    expect(
      (await handshake({ Origin: "https://localhost.evil.example.com" })).status
    ).toBe(401);
  });

  test("a handshake without an Origin header is allowed", async () => {
    // CLI and server-to-server clients send none, and they cannot be tricked
    // into an attack by a web page.
    expect((await handshake({})).status).toBe(200);
  });

  test("a handshake from another site is rejected", async () => {
    expect((await handshake({ Origin: "https://evil.example.com" })).status).toBe(
      401
    );
  });

  test("a configured allowed origin is accepted", async () => {
    _GLOBAL_SERVER_CONFIG.allowedOrigins = ["https://frontend.example.com"];
    expect(
      (await handshake({ Origin: "https://frontend.example.com" })).status
    ).toBe(200);
  });

  test("the configured baseUrl is accepted", async () => {
    _GLOBAL_SERVER_CONFIG.baseUrl = "https://wiki.example.com";
    expect((await handshake({ Origin: "https://wiki.example.com" })).status).toBe(
      200
    );
  });

  test("a wildcard in allowedOrigins does not open the handshake", async () => {
    // A wildcard is consent for public, CORS-governed reads — not for arbitrary
    // sites to open sockets carrying someone else's session.
    _GLOBAL_SERVER_CONFIG.allowedOrigins = ["*"];
    expect((await handshake({ Origin: "https://evil.example.com" })).status).toBe(
      401
    );
  });

  test("a foreign origin on a normal request is left to CORS", async () => {
    // Only handshakes are checked here. A plain request from another origin is
    // governed by the CORS middleware, which is a separate mechanism with its
    // own configuration — duplicating it here would mean two sources of truth.
    const response = await app.request("/socket", {
      headers: {
        Origin: "https://evil.example.com",
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    expect(response.status).toBe(200);
  });
});
