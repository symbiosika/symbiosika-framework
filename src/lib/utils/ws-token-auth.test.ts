import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import type { SFContextVariables } from "../../types";
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
