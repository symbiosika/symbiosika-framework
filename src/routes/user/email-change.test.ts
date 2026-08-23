import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { Hono } from "hono";
import { definePublicUserRoutes } from "./public";
import { defineSecuredUserRoutes } from "./protected";
import type { SymbiosikaFrameworkHonoApp } from "../../types";
import { initTests } from "../../test/init.test";
import { getDb } from "../../lib/db/db-connection";
import { emailChangeRequests, users } from "../../lib/db/db-schema";
import { smtpService } from "../../lib/email";
import { eq, inArray } from "drizzle-orm";
import { generateUserSessionJwt, saltAndHashPassword } from "../../lib/auth";
import { requestEmailChange } from "../../lib/auth/email-change";

const PASSWORD = "gFskj6Dn6gFskj6Dn6";
const USER_EMAIL = "test-route-email-change@symbiosika.de";
const PASSWORDLESS_EMAIL = "test-route-email-change-social@symbiosika.de";
const OTHER_EMAIL = "test-route-email-change-other@symbiosika.de";
const NEW_EMAIL = "test-route-email-change-new@symbiosika.de";

const ALL_TEST_EMAILS = [
  USER_EMAIL,
  PASSWORDLESS_EMAIL,
  OTHER_EMAIL,
  NEW_EMAIL,
];

describe("User email change endpoints", () => {
  const app: SymbiosikaFrameworkHonoApp = new Hono();
  let jwt = "";
  let passwordlessJwt = "";
  let userId = "";
  let passwordlessUserId = "";
  let originalConsoleMode: boolean;

  const cleanup = async () => {
    await getDb().delete(users).where(inArray(users.email, ALL_TEST_EMAILS));
  };

  /** Fresh accounts + JWTs before every test. */
  const createUsers = async () => {
    await cleanup();
    const hash = await saltAndHashPassword(PASSWORD);
    const created = await getDb()
      .insert(users)
      .values([
        {
          email: USER_EMAIL,
          firstname: "Route",
          surname: "Tester",
          password: hash,
          emailVerified: true,
          extUserId: "",
        },
        {
          // No local password: social / magic-link style account.
          email: PASSWORDLESS_EMAIL,
          firstname: "Social",
          surname: "Tester",
          emailVerified: true,
          extUserId: "",
        },
        {
          email: OTHER_EMAIL,
          firstname: "Other",
          surname: "Tester",
          emailVerified: true,
          extUserId: "",
        },
      ])
      .returning({ id: users.id, email: users.email });

    userId = created.find((u) => u.email === USER_EMAIL)!.id;
    passwordlessUserId = created.find(
      (u) => u.email === PASSWORDLESS_EMAIL
    )!.id;

    jwt = (
      await generateUserSessionJwt(
        { id: userId, email: USER_EMAIL, firstname: "", surname: "" },
        86400
      )
    ).token;
    passwordlessJwt = (
      await generateUserSessionJwt(
        {
          id: passwordlessUserId,
          email: PASSWORDLESS_EMAIL,
          firstname: "",
          surname: "",
        },
        86400
      )
    ).token;
  };

  beforeAll(async () => {
    await initTests();

    // Keep the confirmation mails out of the network in this suite.
    const svc = smtpService as unknown as { consoleMode: boolean };
    originalConsoleMode = svc.consoleMode;
    svc.consoleMode = true;

    defineSecuredUserRoutes(app, "/api");
    definePublicUserRoutes(app, "/api");
  });

  beforeEach(async () => {
    await createUsers();
  });

  afterAll(async () => {
    try {
      const svc = smtpService as unknown as { consoleMode: boolean };
      svc.consoleMode = originalConsoleMode;
      await cleanup();
    } catch (err) {
      console.warn("[routes/user email-change.test] cleanup failed:", err);
    }
  });

  const requestChange = (body: Record<string, unknown>, token = jwt) =>
    app.request("/api/user/me/email-change", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `jwt=${token}` },
      body: JSON.stringify(body),
    });

  const emailOf = async (id: string) => {
    const rows = await getDb().select().from(users).where(eq(users.id, id));
    return rows[0]!.email;
  };

  it("requires authentication", async () => {
    const res = await app.request("/api/user/me/email-change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newEmail: NEW_EMAIL, password: PASSWORD }),
    });
    expect(res.status).toBe(401);
  });

  it("requires the current password when the account has one", async () => {
    const withoutPassword = await requestChange({ newEmail: NEW_EMAIL });
    expect(withoutPassword.status).toBe(400);

    const wrongPassword = await requestChange({
      newEmail: NEW_EMAIL,
      password: "wrong-password",
    });
    expect(wrongPassword.status).toBe(401);

    // Nothing was created and the account is untouched.
    expect(await emailOf(userId)).toBe(USER_EMAIL);
    const rows = await getDb()
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, userId));
    expect(rows.length).toBe(0);
  });

  it("creates a pending request and reports it, without changing the account", async () => {
    const res = await requestChange({
      newEmail: NEW_EMAIL,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.newEmail).toBe(NEW_EMAIL);
    expect(body.expiresAt).toBeDefined();

    expect(await emailOf(userId)).toBe(USER_EMAIL);

    const pending = await app.request("/api/user/me/email-change", {
      headers: { Cookie: `jwt=${jwt}` },
    });
    expect(pending.status).toBe(200);
    const pendingBody = (await pending.json()) as Record<string, unknown>;
    expect(pendingBody.pending).toBe(true);
    expect(pendingBody.newEmail).toBe(NEW_EMAIL);
  });

  it("works without a password for accounts that have none", async () => {
    const res = await requestChange({ newEmail: NEW_EMAIL }, passwordlessJwt);
    expect(res.status).toBe(200);
    expect(await emailOf(passwordlessUserId)).toBe(PASSWORDLESS_EMAIL);
  });

  it("rejects a malformed, unchanged or taken address", async () => {
    const malformed = await requestChange({
      newEmail: "not-an-email",
      password: PASSWORD,
    });
    expect(malformed.status).toBe(400);

    const unchanged = await requestChange({
      newEmail: USER_EMAIL,
      password: PASSWORD,
    });
    expect(unchanged.status).toBe(400);

    const taken = await requestChange({
      newEmail: OTHER_EMAIL,
      password: PASSWORD,
    });
    expect(taken.status).toBe(400);
  });

  it("cancels a pending request", async () => {
    await requestChange({ newEmail: NEW_EMAIL, password: PASSWORD });

    const res = await app.request("/api/user/me/email-change", {
      method: "DELETE",
      headers: { Cookie: `jwt=${jwt}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cancelled: number }).cancelled).toBe(1);

    const pending = await app.request("/api/user/me/email-change", {
      headers: { Cookie: `jwt=${jwt}` },
    });
    expect(((await pending.json()) as { pending: boolean }).pending).toBe(
      false
    );
  });

  it("shows the pending change for a token and only applies it on confirm", async () => {
    // The plaintext token only exists at creation time (the DB holds a hash),
    // so the suite creates the request through the library and then drives the
    // public routes exactly as the confirmation page does.
    const request = await requestEmailChange(userId, NEW_EMAIL, false);

    const info = await app.request(
      `/api/user/email-change/info?token=${encodeURIComponent(request.token)}`
    );
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as Record<string, unknown>;
    expect(infoBody.newEmail).toBe(NEW_EMAIL);
    expect(infoBody.oldEmail).toBe(USER_EMAIL);

    // Merely reading the info (what a mail scanner pre-opening the link does)
    // must not change anything.
    expect(await emailOf(userId)).toBe(USER_EMAIL);

    const confirm = await app.request("/api/user/email-change/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: request.token }),
    });
    expect(confirm.status).toBe(200);
    expect(((await confirm.json()) as { email: string }).email).toBe(NEW_EMAIL);
    expect(await emailOf(userId)).toBe(NEW_EMAIL);

    // Single use.
    const replay = await app.request("/api/user/email-change/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: request.token }),
    });
    expect(replay.status).toBe(401);
  });

  it("rejects an unknown token on both public routes", async () => {
    const info = await app.request(
      "/api/user/email-change/info?token=does-not-exist"
    );
    expect(info.status).toBe(401);

    const confirm = await app.request("/api/user/email-change/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "does-not-exist" }),
    });
    expect(confirm.status).toBe(401);
  });
});
