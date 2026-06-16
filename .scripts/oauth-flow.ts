/**
 * End-to-end smoke test for the OAuth2 / OIDC Authorization Server.
 *
 * Runs the FULL flow in-process against a fresh Hono app (no separate server
 * needed) using the real database and test fixtures, then prints a PASS/FAIL
 * summary and exits non-zero on any failure.
 *
 *   Run from the backend directory:
 *     bun run framework/.scripts/oauth-flow.ts
 *
 * Covers: discovery + JWKS, admin client creation, passwordless login (OTP),
 * consent, authorization-code + PKCE, token exchange, id_token (RS256) verified
 * against the published key, userinfo, and the negative paths (no token → 401,
 * wrong PKCE verifier, refresh rotation + reuse-detection, revocation).
 */
import { Hono } from "hono";
import * as crypto from "crypto";
import jwt from "jsonwebtoken";
import { setGlobalServerConfig, _GLOBAL_SERVER_CONFIG } from "../src/store";
import { defineOAuth2Routes } from "../src/lib/oauth2";
import { computeS256Challenge } from "../src/lib/oauth2/pkce";
import { getOidcKeyMaterial } from "../src/lib/oauth2/keys";
import { createEmailLoginCode } from "../src/lib/auth/email-otp";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../src/test/init.test";

const BASE = "http://localhost";
const REDIRECT = "http://127.0.0.1:9999/cb";

// ---- tiny assertion harness -------------------------------------------------
let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
};

// ---- in-process fetch with a cookie jar ------------------------------------
const jar = new Map<string, string>();
const cookieHeader = () =>
  Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

let app: Hono;

type Res = { status: number; headers: Headers; body: any; text: string };

const call = async (
  method: string,
  path: string,
  opts: { json?: any; form?: Record<string, string>; accept?: string } = {}
): Promise<Res> => {
  const headers: Record<string, string> = {};
  if (jar.size) headers.cookie = cookieHeader();
  if (opts.accept) headers.accept = opts.accept;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await app.fetch(
    new Request(BASE + path, { method, headers, body, redirect: "manual" })
  );
  // absorb cookies
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (m) jar.set(m[1], m[2]);
  }
  const text = await res.text();
  let parsed: any = undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, body: parsed, text };
};

async function main() {
  console.log("\n=== OAuth2 / OIDC end-to-end flow ===\n");

  // Configure + boot fixtures.
  setGlobalServerConfig({
    appName: "OAuthFlowTest",
    baseUrl: BASE,
    oauth2: { enabled: true, requireConsentScreen: true },
  });
  await initTests();
  await getOidcKeyMaterial(); // ensure server signing key exists

  app = new Hono();
  defineOAuth2Routes(app, _GLOBAL_SERVER_CONFIG.basePath);

  const base = _GLOBAL_SERVER_CONFIG.basePath; // "/api/v1"

  // 0) Discovery + JWKS
  const oidcCfg = await call("GET", "/.well-known/openid-configuration");
  check(
    "openid-configuration has endpoints",
    oidcCfg.status === 200 &&
      !!oidcCfg.body?.authorization_endpoint &&
      !!oidcCfg.body?.token_endpoint &&
      !!oidcCfg.body?.jwks_uri
  );
  check(
    "id_token_signing_alg = RS256",
    (oidcCfg.body?.id_token_signing_alg_values_supported ?? []).includes(
      "RS256"
    )
  );
  const jwks = await call("GET", "/.well-known/jwks.json");
  const jwk = jwks.body?.keys?.[0];
  check("jwks exposes an RSA key with kid", jwk?.kty === "RSA" && !!jwk?.kid);

  // 1) Login (passwordless OTP) → session cookie
  const code = await createEmailLoginCode(TEST_ORG1_USER_1.email);
  const login = await call("POST", "/oauth/login/verify", {
    json: { email: TEST_ORG1_USER_1.email, code },
  });
  check("login/verify ok + sets session cookie", login.body?.ok === true && jar.has("jwt"));

  // 2) Admin creates a confidential client (tests the protected route)
  const created = await call(
    "POST",
    `${base}/tenant/${TEST_ORGANISATION_1.id}/oauth/clients`,
    {
      json: {
        clientName: "Flow Tester",
        redirectUris: [REDIRECT],
        scopes: ["user:read"],
        clientType: "confidential",
      },
    }
  );
  const clientId = created.body?.clientId;
  const clientSecret = created.body?.clientSecret;
  check(
    "admin created client (id + one-time secret)",
    created.status === 200 && !!clientId && !!clientSecret
  );

  // 3) Authorize (PKCE) → consent → code
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = computeS256Challenge(verifier);
  const state = crypto.randomBytes(8).toString("hex");
  const nonce = crypto.randomBytes(8).toString("hex");
  const authQuery = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid profile email user:read",
    state,
    nonce,
    tenant_id: TEST_ORGANISATION_1.id,
  }).toString();

  const authz = await call("GET", `/oauth/authorize?${authQuery}`, {
    accept: "application/json",
  });
  check("authorize requires consent", authz.body?.step === "consent");

  const consent = await call("POST", "/oauth/consent", {
    accept: "application/json",
    form: { authorize_query: authQuery, decision: "approve" },
  });
  const redirect = consent.body?.redirect as string | undefined;
  const codeParam = redirect ? new URL(redirect).searchParams.get("code") : null;
  const stateParam = redirect
    ? new URL(redirect).searchParams.get("state")
    : null;
  check("consent returns code + matching state", !!codeParam && stateParam === state);

  // 4) Token exchange (authorization_code + PKCE + client_secret)
  const tok = await call("POST", "/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: codeParam ?? "",
      redirect_uri: REDIRECT,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    },
  });
  check(
    "token: access + refresh + id_token issued",
    tok.status === 200 &&
      !!tok.body?.access_token &&
      !!tok.body?.refresh_token &&
      !!tok.body?.id_token
  );

  // 5) id_token verifies against the published RSA key, with correct claims
  const { publicPem, kid } = await getOidcKeyMaterial();
  let idOk = false;
  try {
    const decoded: any = jwt.verify(tok.body.id_token, publicPem, {
      algorithms: ["RS256"],
      audience: clientId,
      issuer: BASE,
    });
    const hdr = JSON.parse(
      Buffer.from(tok.body.id_token.split(".")[0], "base64url").toString()
    );
    idOk =
      decoded.sub === TEST_ORG1_USER_1.id &&
      decoded.nonce === nonce &&
      decoded.email === TEST_ORG1_USER_1.email &&
      hdr.kid === kid;
  } catch (e) {
    idOk = false;
  }
  check("id_token RS256-verifies (sub/nonce/email/kid)", idOk);

  // 6) UserInfo with the access token
  const ui = await app
    .fetch(
      new Request(BASE + "/oauth/userinfo", {
        headers: { authorization: `Bearer ${tok.body.access_token}` },
      })
    )
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  check(
    "userinfo returns sub + email",
    ui.status === 200 &&
      ui.body?.sub === TEST_ORG1_USER_1.id &&
      ui.body?.email === TEST_ORG1_USER_1.email
  );

  // 7) UserInfo without a token → 401
  const uiNo = await app.fetch(new Request(BASE + "/oauth/userinfo"));
  check("userinfo without token → 401", uiNo.status === 401);

  // 8) PKCE negative: fresh code, wrong verifier → invalid_grant
  {
    const v2 = crypto.randomBytes(32).toString("base64url");
    const c2 = computeS256Challenge(v2);
    const q2 = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: c2,
      code_challenge_method: "S256",
      scope: "openid",
      tenant_id: TEST_ORGANISATION_1.id,
    }).toString();
    // consent already persisted → authorize returns redirect directly
    const a2 = await call("GET", `/oauth/authorize?${q2}`, {
      accept: "application/json",
    });
    const code2 = a2.body?.redirect
      ? new URL(a2.body.redirect).searchParams.get("code")
      : null;
    const bad = await call("POST", "/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code: code2 ?? "",
        redirect_uri: REDIRECT,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: "wrong-verifier",
      },
    });
    check(
      "consent remembered (authorize → direct redirect)",
      a2.body?.step === "redirect" && !!code2
    );
    check("wrong PKCE verifier → rejected", bad.status === 400);
  }

  // 9) Refresh rotation + reuse-detection
  const oldRefresh = tok.body.refresh_token;
  const refreshed = await call("POST", "/oauth/token", {
    form: {
      grant_type: "refresh_token",
      refresh_token: oldRefresh,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
  check(
    "refresh returns a new token pair",
    refreshed.status === 200 &&
      !!refreshed.body?.access_token &&
      !!refreshed.body?.refresh_token &&
      refreshed.body.refresh_token !== oldRefresh
  );
  const reuse = await call("POST", "/oauth/token", {
    form: {
      grant_type: "refresh_token",
      refresh_token: oldRefresh, // reuse the rotated-away token
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
  check("reusing an old refresh token → rejected", reuse.status === 400);

  // 10) Revocation
  const newRefresh = refreshed.body.refresh_token;
  await call("POST", "/oauth/revoke", {
    form: { token: newRefresh, client_id: clientId, client_secret: clientSecret },
  });
  const afterRevoke = await call("POST", "/oauth/token", {
    form: {
      grant_type: "refresh_token",
      refresh_token: newRefresh,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
  check("revoked refresh token → rejected", afterRevoke.status === 400);

  // ---- summary ----
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed === 0) {
    console.log("✅ PASS — full OAuth2/OIDC flow works.\n");
    process.exit(0);
  } else {
    console.log("❌ FAIL — see failures above.\n");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\n❌ FAIL — unexpected error:", e);
  process.exit(1);
});
