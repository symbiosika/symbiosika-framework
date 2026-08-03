import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import type { SymbiosikaFrameworkHonoApp } from "../../types";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { getDb } from "../../lib/db/db-connection";
import { users } from "../../lib/db/db-schema";
import { initTests } from "../../test/init.test";
import {
  OAUTH_LOGIN_TX_COOKIE,
  createOAuthRandomToken,
  encodeOAuthTransaction,
} from "../../lib/auth/oauth2";
import { definePublicUserRoutes } from "./public";

/**
 * Route behaviour of the social login. The provider is stubbed via `fetch`, so
 * the whole round-trip is exercised without leaving the process: start →
 * authorize redirect → callback → auth cookies.
 */
const app: SymbiosikaFrameworkHonoApp = new Hono();

const TEST_EMAIL = "oauth-route-user@symbiosika.de";

const readTransactionCookie = (setCookie: string | null) => {
  const value = decodeURIComponent(
    (setCookie ?? "").split(`${OAUTH_LOGIN_TX_COOKIE}=`)[1]?.split(";")[0] ?? ""
  );
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
};

const originalEnv = {
  clientId: process.env.MICROSOFT_CLIENT_ID,
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
};

const enableProvider = () => {
  process.env.MICROSOFT_CLIENT_ID = "ms-client-id";
  process.env.MICROSOFT_CLIENT_SECRET = "ms-client-secret";
};

const disableProvider = () => {
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;
};

describe("Social login routes", () => {
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    await initTests();
    definePublicUserRoutes(app, "/api/v1");

    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/oauth2/v2.0/token")) {
        return Response.json({ access_token: "ms-access" });
      }
      if (url.includes("graph.microsoft.com")) {
        return Response.json({
          id: "ms-object-id",
          userPrincipalName: TEST_EMAIL,
          givenName: "Route",
          surname: "Tester",
        });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (originalEnv.clientId === undefined)
      delete process.env.MICROSOFT_CLIENT_ID;
    else process.env.MICROSOFT_CLIENT_ID = originalEnv.clientId;
    if (originalEnv.clientSecret === undefined)
      delete process.env.MICROSOFT_CLIENT_SECRET;
    else process.env.MICROSOFT_CLIENT_SECRET = originalEnv.clientSecret;

    try {
      await getDb().delete(users).where(inArray(users.email, [TEST_EMAIL]));
    } catch (err) {
      console.warn("[oauth-login.test] cleanup failed:", err);
    }
  });

  test("oauth-providers reports only fully configured providers", async () => {
    disableProvider();
    let response = await app.request("/api/v1/user/oauth-providers");
    expect(((await response.json()) as any).microsoft).toBe(false);

    enableProvider();
    response = await app.request("/api/v1/user/oauth-providers");
    expect(((await response.json()) as any).microsoft).toBe(true);
  });

  test("an unconfigured provider bounces back to the login page", async () => {
    disableProvider();

    const response = await app.request("/api/v1/user/auth/microsoft");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${_GLOBAL_SERVER_CONFIG.loginUrl}?error=oauth_unavailable`
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("an unknown provider is rejected", async () => {
    enableProvider();

    const response = await app.request("/api/v1/user/auth/facebook");

    expect(response.headers.get("location")).toBe(
      `${_GLOBAL_SERVER_CONFIG.loginUrl}?error=oauth_unavailable`
    );
  });

  test("start redirects to the provider and pins state + verifier", async () => {
    enableProvider();

    const response = await app.request(
      "/api/v1/user/auth/microsoft?redirectUrl=%2Fstatic%2Fapp%2F"
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://login.microsoftonline.com");

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const transaction = readTransactionCookie(cookie);
    expect(transaction.state).toBe(location.searchParams.get("state"));
    expect(transaction.redirect).toBe("/static/app/");
    expect(transaction.verifier).toBeTruthy();
    // The verifier itself must never leave the server
    expect(location.search).not.toContain(transaction.verifier);
  });

  test("an off-site redirect target is replaced by the default", async () => {
    enableProvider();

    const response = await app.request(
      "/api/v1/user/auth/microsoft?redirectUrl=https%3A%2F%2Fevil.example.com"
    );

    expect(readTransactionCookie(response.headers.get("set-cookie")).redirect)
      .toBe(`${_GLOBAL_SERVER_CONFIG.oauthCallbackUrl}?provider=microsoft`);
  });

  test("the callback signs the user in and sets the auth cookies", async () => {
    enableProvider();

    const start = await app.request(
      "/api/v1/user/auth/microsoft?redirectUrl=%2Fstatic%2Fapp%2F"
    );
    const startCookie = start.headers.get("set-cookie") ?? "";
    const txValue = startCookie
      .split(`${OAUTH_LOGIN_TX_COOKIE}=`)[1]!
      .split(";")[0]!;
    const state = new URL(start.headers.get("location") ?? "").searchParams.get(
      "state"
    );

    const response = await app.request(
      `/api/v1/user/auth/microsoft/callback?code=auth-code&state=${encodeURIComponent(state ?? "")}`,
      { headers: { Cookie: `${OAUTH_LOGIN_TX_COOKIE}=${txValue}` } }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/static/app/");

    const setCookies = response.headers.getSetCookie().join("\n");
    // The session lands in the HttpOnly cookie plus the SPA's marker …
    expect(setCookies).toMatch(/(^|\n)jwt=[^;]+/);
    expect(setCookies).toContain("jwt_present=1");
    // … and never in the URL
    expect(response.headers.get("location")).not.toContain("token");
    // the one-shot transaction cookie is cleared
    expect(setCookies).toContain(`${OAUTH_LOGIN_TX_COOKIE}=;`);
  });

  test("the callback without a transaction cookie fails closed", async () => {
    enableProvider();

    const response = await app.request(
      "/api/v1/user/auth/microsoft/callback?code=abc&state=xyz"
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${_GLOBAL_SERVER_CONFIG.loginUrl}?error=oauth_failed`
    );
    expect(response.headers.getSetCookie().join("\n")).not.toContain("jwt=");
  });

  test("the callback rejects a mismatching state (CSRF)", async () => {
    enableProvider();

    const transaction = encodeOAuthTransaction({
      state: createOAuthRandomToken(),
      verifier: createOAuthRandomToken(),
      redirect: "/static/app/",
    });

    const response = await app.request(
      "/api/v1/user/auth/microsoft/callback?code=abc&state=someone-elses-state",
      { headers: { Cookie: `${OAUTH_LOGIN_TX_COOKIE}=${transaction}` } }
    );

    expect(response.headers.get("location")).toBe(
      `${_GLOBAL_SERVER_CONFIG.loginUrl}?error=oauth_failed`
    );
    expect(response.headers.getSetCookie().join("\n")).not.toContain("jwt=");
  });

  test("a cancelled consent screen is reported as cancelled", async () => {
    enableProvider();

    const response = await app.request(
      "/api/v1/user/auth/microsoft/callback?error=access_denied&error_description=user+cancelled"
    );

    expect(response.headers.get("location")).toBe(
      `${_GLOBAL_SERVER_CONFIG.loginUrl}?error=oauth_cancelled`
    );
  });
});
