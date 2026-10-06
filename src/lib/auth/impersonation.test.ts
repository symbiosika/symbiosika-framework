import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import jwtlib from "jsonwebtoken";
import type {
  SFContextVariables,
  SymbiosikaFrameworkHonoApp,
} from "../../types";
import {
  initTests,
  TEST_ADMIN_USER,
  TEST_ORG1_USER_1,
  TEST_ORGANISATION_1,
} from "../../test/init.test";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { getDb } from "../db/db-connection";
import { oauthClients, users } from "../db/db-schema";
import { defineOAuth2Routes } from "../oauth2";
import { createOAuthClient } from "../oauth2/clients";
import { authAndSetUsersInfo } from "../utils/hono-middlewares";
import { defineSecuredUserRoutes } from "../../routes/user/protected";
import {
  createImpersonationSession,
  forbidDuringImpersonation,
  parseActClaim,
} from "./impersonation";
import { generateUserSessionJwt } from "./index";
import { revokeSession } from "./sessions";

const ACTOR = { id: TEST_ADMIN_USER.id, email: TEST_ADMIN_USER.email };

const app = new Hono<{ Variables: SFContextVariables }>();
app.get("/whoami", authAndSetUsersInfo, (c) =>
  c.json({
    usersId: c.get("usersId"),
    usersEmail: c.get("usersEmail"),
    actor: c.get("actor") ?? null,
  })
);
app.post("/sensitive", authAndSetUsersInfo, forbidDuringImpersonation, (c) =>
  c.json({ ok: true })
);

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let userToken: string;

describe("parseActClaim", () => {
  test("reads sub and email", () => {
    expect(parseActClaim({ sub: "a1", email: "a@x.de" })).toEqual({
      id: "a1",
      email: "a@x.de",
    });
  });

  test("tolerates a missing email", () => {
    expect(parseActClaim({ sub: "a1" })).toEqual({ id: "a1", email: "" });
  });

  test("ignores missing or malformed claims", () => {
    expect(parseActClaim(undefined)).toBeUndefined();
    expect(parseActClaim("a1")).toBeUndefined();
    expect(parseActClaim({ email: "a@x.de" })).toBeUndefined();
    expect(parseActClaim({ sub: "" })).toBeUndefined();
    expect(parseActClaim({ sub: 42 })).toBeUndefined();
  });
});

describe("Impersonation sessions", () => {
  beforeAll(async () => {
    const { user1Token } = await initTests();
    userToken = user1Token;
  });

  test("the token is a session for the target with the actor in `act`", async () => {
    const { token, sid, user } = await createImpersonationSession({
      targetUserId: TEST_ORG1_USER_1.id,
      actor: ACTOR,
    });

    expect(user.id).toBe(TEST_ORG1_USER_1.id);
    const claims = jwtlib.decode(token) as any;
    expect(claims.sub).toBe(TEST_ORG1_USER_1.id);
    expect(claims.email).toBe(TEST_ORG1_USER_1.email);
    expect(claims.sid).toBe(sid);
    expect(claims.act).toEqual({ sub: ACTOR.id, email: ACTOR.email });
    // Default lifetime: 1 hour.
    expect(claims.exp - claims.iat).toBe(60 * 60);
  });

  test("the middleware exposes the actor, also on a cached token", async () => {
    const { token } = await createImpersonationSession({
      targetUserId: TEST_ORG1_USER_1.id,
      actor: ACTOR,
    });

    // First request verifies the JWT, the second one is served from the cache.
    for (let i = 0; i < 2; i++) {
      const res = await app.request("/whoami", { headers: bearer(token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.usersId).toBe(TEST_ORG1_USER_1.id);
      expect(body.usersEmail).toBe(TEST_ORG1_USER_1.email);
      expect(body.actor).toEqual(ACTOR);
    }
  });

  test("a normal login has no actor", async () => {
    const res = await app.request("/whoami", { headers: bearer(userToken) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).actor).toBeNull();
  });

  test("forbidDuringImpersonation blocks impersonation tokens only", async () => {
    const { token } = await createImpersonationSession({
      targetUserId: TEST_ORG1_USER_1.id,
      actor: ACTOR,
    });

    const blocked = await app.request("/sensitive", {
      method: "POST",
      headers: bearer(token),
    });
    expect(blocked.status).toBe(403);

    const allowed = await app.request("/sensitive", {
      method: "POST",
      headers: bearer(userToken),
    });
    expect(allowed.status).toBe(200);
  });

  test("revoking the session ends the impersonation", async () => {
    const { token, sid } = await createImpersonationSession({
      targetUserId: TEST_ORG1_USER_1.id,
      actor: ACTOR,
    });
    expect(
      (await app.request("/whoami", { headers: bearer(token) })).status
    ).toBe(200);

    await revokeSession(sid);

    expect(
      (await app.request("/whoami", { headers: bearer(token) })).status
    ).toBe(401);
  });

  test("a custom lifetime is honoured", async () => {
    const { token } = await createImpersonationSession({
      targetUserId: TEST_ORG1_USER_1.id,
      actor: ACTOR,
      expiresIn: 300,
    });
    const claims = jwtlib.decode(token) as any;
    expect(claims.exp - claims.iat).toBe(300);
  });

  test("rejects self-impersonation and unknown users", async () => {
    expect(
      createImpersonationSession({
        targetUserId: ACTOR.id,
        actor: ACTOR,
      })
    ).rejects.toThrow("cannot impersonate themselves");

    expect(
      createImpersonationSession({
        targetUserId: "00000000-9999-9999-9999-000000000099",
        actor: ACTOR,
      })
    ).rejects.toThrow("User not found");
  });

  test("additional claims cannot replace the session id", async () => {
    const { token, sid } = await generateUserSessionJwt(
      {
        id: TEST_ORG1_USER_1.id,
        email: TEST_ORG1_USER_1.email,
        firstname: "",
        surname: "",
      },
      60,
      { sid: "forged-session", custom: "value" }
    );
    const claims = jwtlib.decode(token) as any;
    expect(claims.sid).toBe(sid);
    expect(claims.custom).toBe("value");
  });
});

describe("User routes during impersonation", () => {
  const userApp: SymbiosikaFrameworkHonoApp = new Hono();
  let impersonationToken: string;

  beforeAll(async () => {
    await initTests();
    defineSecuredUserRoutes(userApp, "/api");
    ({ token: impersonationToken } = await createImpersonationSession({
      targetUserId: TEST_ORG1_USER_1.id,
      actor: ACTOR,
    }));
  });

  test("reading the own profile works and names the actor", async () => {
    const res = await userApp.request("/api/user/me", {
      headers: bearer(impersonationToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(TEST_ORG1_USER_1.id);
    expect(body.email).toBe(TEST_ORG1_USER_1.email);
    // Other suites rename the admin in the shared test DB, so compare against
    // the stored row instead of the seed constants.
    const [actorRow] = await getDb()
      .select({ firstname: users.firstname, surname: users.surname })
      .from(users)
      .where(eq(users.id, ACTOR.id));
    expect(body.actor).toEqual({
      id: ACTOR.id,
      email: ACTOR.email,
      firstname: actorRow!.firstname,
      surname: actorRow!.surname,
    });
    const expiresAt = new Date(body.sessionExpiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  test("/user/me of a normal session has no actor", async () => {
    const { user1Token } = await initTests();
    const res = await userApp.request("/api/user/me", {
      headers: bearer(user1Token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(TEST_ORG1_USER_1.id);
    expect(body.actor).toBeNull();
    expect("sessionExpiresAt" in body).toBe(true);
  });

  test("/user/me tolerates an actor that no longer exists", async () => {
    const goneActor = {
      id: "00000000-9999-9999-9999-000000000098",
      email: "gone@symbiosika.com",
    };
    const { token } = await createImpersonationSession({
      targetUserId: TEST_ORG1_USER_1.id,
      actor: goneActor,
    });
    const res = await userApp.request("/api/user/me", {
      headers: bearer(token),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).actor).toEqual({
      ...goneActor,
      firstname: null,
      surname: null,
    });
  });

  test.each([
    ["PUT", "/api/user/me/password"],
    ["POST", "/api/user/me/email-change"],
    ["POST", "/api/user/api-tokens"],
    ["POST", "/api/user/passkey/registration/options"],
    ["POST", "/api/user/passkey/registration/verify"],
    ["DELETE", "/api/user/passkeys/some-passkey"],
    ["GET", "/api/user/refresh-token"],
  ])("%s %s is forbidden", async (method, path) => {
    const res = await userApp.request(path, {
      method,
      headers: {
        ...bearer(impersonationToken),
        "Content-Type": "application/json",
      },
      body:
        method === "DELETE" || method === "GET"
          ? undefined
          : JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});

describe("OAuth authorize during impersonation", () => {
  const oauthApp = new Hono();
  const redirectUri = "http://localhost:4999/callback";
  let clientId: string;
  let impersonationToken: string;
  let wasEnabled: boolean;

  beforeAll(async () => {
    const { user1Token } = await initTests();
    userToken = user1Token;
    wasEnabled = _GLOBAL_SERVER_CONFIG.oauth2.enabled;
    _GLOBAL_SERVER_CONFIG.oauth2.enabled = true;
    defineOAuth2Routes(oauthApp as any, "/api");

    ({ clientId } = await createOAuthClient({
      tenantId: TEST_ORGANISATION_1.id,
      clientName: "impersonation-test",
      clientType: "public",
      redirectUris: [redirectUri],
      scopes: [],
    }));
    ({ token: impersonationToken } = await createImpersonationSession({
      targetUserId: TEST_ORG1_USER_1.id,
      actor: ACTOR,
    }));
  });

  afterAll(async () => {
    _GLOBAL_SERVER_CONFIG.oauth2.enabled = wasEnabled;
    await getDb().delete(oauthClients).where(eq(oauthClients.clientId, clientId));
  });

  const authorize = (token: string) =>
    oauthApp.request(
      "/oauth/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "openid",
          code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          code_challenge_method: "S256",
          tenant_id: TEST_ORGANISATION_1.id,
        }),
      { headers: { ...bearer(token), Accept: "application/json" } }
    );

  test("an impersonation session must log in as the real user", async () => {
    const res = await authorize(impersonationToken);
    expect(((await res.json()) as any).step).toBe("login");
  });

  test("a normal session is recognised as logged in", async () => {
    const res = await authorize(userToken);
    const body = (await res.json().catch(() => ({}))) as any;
    expect(body.step).not.toBe("login");
  });
});
