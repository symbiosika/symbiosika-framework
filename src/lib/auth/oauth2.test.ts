import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { getDb } from "../db/db-connection";
import { users } from "../db/db-schema";
import { initTests, TEST_ORG1_USER_1 } from "../../test/init.test";
import { createMagicLinkToken, verifyMagicLink } from "./magic-link";
import {
  OAuthAuth,
  createOAuthCodeChallenge,
  createOAuthRandomToken,
  decodeOAuthTransaction,
  encodeOAuthTransaction,
  getOAuthRedirectUri,
  isOAuthProvider,
  isOAuthProviderActive,
  isSameOAuthState,
  sanitizeOAuthRedirect,
} from "./oauth2";

/**
 * Provider credentials are read lazily, so a suite can switch them on and off.
 */
const ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_TENANT_ID",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

const restoreEnv = () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const enableMicrosoft = () => {
  process.env.MICROSOFT_CLIENT_ID = "ms-client-id";
  process.env.MICROSOFT_CLIENT_SECRET = "ms-client-secret";
};

describe("OAuth provider configuration", () => {
  afterAll(restoreEnv);

  test("a provider needs client id AND secret to count as active", () => {
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    expect(isOAuthProviderActive("microsoft")).toBe(false);

    // The confidential-client token exchange cannot work without the secret,
    // so a client id alone must not advertise the provider.
    process.env.MICROSOFT_CLIENT_ID = "ms-client-id";
    expect(isOAuthProviderActive("microsoft")).toBe(false);

    process.env.MICROSOFT_CLIENT_SECRET = "ms-client-secret";
    expect(isOAuthProviderActive("microsoft")).toBe(true);
    expect(OAuthAuth.getAvailableOAuthProviders().microsoft).toBe(true);
  });

  test("only known providers are accepted", () => {
    expect(isOAuthProvider("google")).toBe(true);
    expect(isOAuthProvider("microsoft")).toBe(true);
    expect(isOAuthProvider("facebook")).toBe(false);
    expect(isOAuthProvider("")).toBe(false);
  });

  test("the redirect URI is derived from baseUrl + basePath", () => {
    const originalBaseUrl = _GLOBAL_SERVER_CONFIG.baseUrl;
    const originalBasePath = _GLOBAL_SERVER_CONFIG.basePath;

    _GLOBAL_SERVER_CONFIG.baseUrl = "https://app.example.com";
    _GLOBAL_SERVER_CONFIG.basePath = "/api/v1";
    expect(getOAuthRedirectUri("microsoft")).toBe(
      "https://app.example.com/api/v1/user/auth/microsoft/callback"
    );

    // A trailing slash in the base path must not double up
    _GLOBAL_SERVER_CONFIG.basePath = "/api/v1/";
    expect(getOAuthRedirectUri("google")).toBe(
      "https://app.example.com/api/v1/user/auth/google/callback"
    );

    _GLOBAL_SERVER_CONFIG.baseUrl = originalBaseUrl;
    _GLOBAL_SERVER_CONFIG.basePath = originalBasePath;
  });

  test("the authorize URL carries client, state and PKCE", () => {
    enableMicrosoft();
    process.env.MICROSOFT_TENANT_ID = "contoso";

    const url = new URL(
      OAuthAuth.getAuthUrl("microsoft", {
        state: "st4te",
        codeChallenge: "ch4llenge",
      })
    );

    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe("/contoso/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe("ms-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("code_challenge")).toBe("ch4llenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      getOAuthRedirectUri("microsoft")
    );
    // The client secret must never reach a browser-visible URL
    expect(url.search).not.toContain("ms-client-secret");
  });

  test("Microsoft falls back to the common directory", () => {
    enableMicrosoft();
    delete process.env.MICROSOFT_TENANT_ID;

    const url = new URL(OAuthAuth.getMicrosoftAuthUrl({ state: "s" }));
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
  });

  test("Google gets its own authorize endpoint", () => {
    process.env.GOOGLE_CLIENT_ID = "g-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "g-client-secret";

    const url = new URL(
      OAuthAuth.getGoogleAuthUrl({ state: "s", codeChallenge: "c" })
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("g-client-id");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("OAuth login transaction", () => {
  test("the PKCE challenge matches the RFC 7636 example", () => {
    // Test vector from RFC 7636 Appendix B
    expect(
      createOAuthCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("random tokens are URL-safe and unique", () => {
    const a = createOAuthRandomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(createOAuthRandomToken());
  });

  test("state comparison accepts only the exact value", () => {
    expect(isSameOAuthState("abc", "abc")).toBe(true);
    expect(isSameOAuthState("abc", "abd")).toBe(false);
    expect(isSameOAuthState("abc", "abcd")).toBe(false);
    expect(isSameOAuthState("abc", "")).toBe(false);
  });

  test("the transaction survives a cookie round-trip", () => {
    const tx = { state: "s1", verifier: "v1", redirect: "/app/" };
    expect(decodeOAuthTransaction(encodeOAuthTransaction(tx))).toEqual(tx);
  });

  test("unusable transaction cookies decode to null", () => {
    expect(decodeOAuthTransaction(undefined)).toBeNull();
    expect(decodeOAuthTransaction("")).toBeNull();
    expect(decodeOAuthTransaction("not-base64-json")).toBeNull();
    expect(
      decodeOAuthTransaction(
        Buffer.from(JSON.stringify({ state: "s" }), "utf8").toString("base64url")
      )
    ).toBeNull();
  });

  test("only server-relative redirect targets survive", () => {
    expect(sanitizeOAuthRedirect("/wiki/page-1", "/fallback")).toBe(
      "/wiki/page-1"
    );
    expect(sanitizeOAuthRedirect(undefined, "/fallback")).toBe("/fallback");
    expect(sanitizeOAuthRedirect("", "/fallback")).toBe("/fallback");
    // Open-redirect attempts
    expect(sanitizeOAuthRedirect("//evil.example.com", "/fallback")).toBe(
      "/fallback"
    );
    expect(sanitizeOAuthRedirect("https://evil.example.com", "/fallback")).toBe(
      "/fallback"
    );
  });
});

/**
 * End-to-end callback handling with the provider stubbed out: `fetch` answers
 * the token and profile requests, everything else (user resolution, session
 * creation) runs for real against the test database.
 */
describe("OAuth callback handling", () => {
  const realFetch = globalThis.fetch;
  const NEW_USER_EMAIL = "oauth-new-user@symbiosika.de";

  let profileResponse: Record<string, unknown> = {};
  let tokenResponse: Record<string, unknown> = { access_token: "ms-access" };
  const requests: { url: string; body?: string }[] = [];

  beforeAll(async () => {
    await initTests();
    enableMicrosoft();

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      requests.push({ url, body: init?.body?.toString() });

      if (url.includes("/oauth2/v2.0/token")) {
        return Response.json(tokenResponse, {
          status: tokenResponse.error ? 400 : 200,
        });
      }
      if (url.includes("graph.microsoft.com")) {
        return Response.json(profileResponse);
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    restoreEnv();
    try {
      await getDb().delete(users).where(inArray(users.email, [NEW_USER_EMAIL]));
    } catch (err) {
      console.warn("[oauth2.test] cleanup failed:", err);
    }
  });

  test("signs in an existing magic-link account instead of duplicating it", async () => {
    // Regression: resolving by `email + provider` tried to INSERT a second row
    // for an address that already existed, which the unique index on
    // users.email rejects — social login was impossible for every account that
    // had been created another way.
    profileResponse = {
      id: "ms-object-id-1",
      mail: TEST_ORG1_USER_1.email.toUpperCase(),
      givenName: "Ignored",
      surname: "Ignored",
    };

    const result = await OAuthAuth.handleCallback(
      "microsoft",
      "auth-code",
      "pkce-verifier"
    );

    expect(result.user.id).toBe(TEST_ORG1_USER_1.id);
    expect(result.token.split(".").length).toBe(3);

    const rows = await getDb()
      .select({
        id: users.id,
        provider: users.provider,
        emailVerified: users.emailVerified,
        extUserId: users.extUserId,
      })
      .from(users)
      .where(eq(users.email, TEST_ORG1_USER_1.email));

    expect(rows.length).toBe(1);
    // The original provider is preserved; only the external id is linked
    expect(rows[0]?.provider).toBe("local");
    expect(rows[0]?.extUserId).toBe("ms-object-id-1");
    expect(rows[0]?.emailVerified).toBe(true);
  });

  test("sends the PKCE verifier and the secret to the token endpoint", async () => {
    const tokenRequest = requests.find((r) =>
      r.url.includes("/oauth2/v2.0/token")
    );
    const body = new URLSearchParams(tokenRequest?.body ?? "");

    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("pkce-verifier");
    expect(body.get("client_secret")).toBe("ms-client-secret");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(getOAuthRedirectUri("microsoft"));
  });

  test("registers an unknown address as a verified account", async () => {
    profileResponse = {
      id: "ms-object-id-2",
      userPrincipalName: NEW_USER_EMAIL,
      givenName: "Mia",
      surname: "Muster",
    };

    const result = await OAuthAuth.handleCallback("microsoft", "code-2", "v-2");

    const rows = await getDb()
      .select({
        id: users.id,
        provider: users.provider,
        firstname: users.firstname,
        surname: users.surname,
        emailVerified: users.emailVerified,
      })
      .from(users)
      .where(eq(users.email, NEW_USER_EMAIL));

    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(result.user.id);
    expect(rows[0]?.provider).toBe("microsoft");
    expect(rows[0]?.firstname).toBe("Mia");
    expect(rows[0]?.surname).toBe("Muster");
    expect(rows[0]?.emailVerified).toBe(true);
  });

  test("an account created via OAuth can still use the magic link", async () => {
    // Both login methods must stay open on the same account: `users.provider`
    // only records how the account came to be, it never gates a login. The
    // magic-link flow resolves by e-mail and redeems by user id — no provider
    // check anywhere in between.
    const rows = await getDb()
      .select({ id: users.id, provider: users.provider })
      .from(users)
      .where(eq(users.email, NEW_USER_EMAIL));
    expect(rows[0]?.provider).toBe("microsoft");

    const magicToken = await createMagicLinkToken(NEW_USER_EMAIL, "login");
    const { user, token } = await verifyMagicLink(magicToken);

    expect(user.id).toBe(rows[0]?.id);
    expect(token.split(".").length).toBe(3);
  });

  test("a second login with the same account does not create a duplicate", async () => {
    profileResponse = {
      id: "ms-object-id-2",
      userPrincipalName: NEW_USER_EMAIL,
    };

    await OAuthAuth.handleCallback("microsoft", "code-3", "v-3");

    const rows = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, NEW_USER_EMAIL));

    expect(rows.length).toBe(1);
  });

  test("a failed token exchange surfaces as an error", async () => {
    tokenResponse = { error: "invalid_grant", error_description: "expired" };

    await expect(
      OAuthAuth.handleCallback("microsoft", "stale-code", "v-4")
    ).rejects.toThrow(/invalid_grant/);

    tokenResponse = { access_token: "ms-access" };
  });

  test("a profile without an e-mail address is rejected", async () => {
    profileResponse = { id: "ms-object-id-3" };

    await expect(
      OAuthAuth.handleCallback("microsoft", "code-5", "v-5")
    ).rejects.toThrow(/e-mail/i);
  });
});
