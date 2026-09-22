import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../db/db-connection";
import { eq, inArray } from "drizzle-orm";
import { users } from "../db/db-schema";
import { LocalAuth } from "./index";
import { createMagicLinkToken } from "./magic-link";
import {
  PreRegisterVerificationError,
  postRegisterActions,
  preRegisterCustomVerifications,
  registerPostRegisterAction,
  registerPreRegisterCustomVerification,
  runPreRegisterVerifications,
} from "./actions";
import { definePublicUserRoutes } from "../../routes/user/public";
import { smtpService } from "../email";
import type { SymbiosikaFrameworkHonoApp } from "../../types";

/**
 * The optional pre-register hook (`customPreRegisterCustomVerifications`).
 *
 * An app uses it to refuse an address before an account exists (e.g. staff
 * addresses that must never sign up as ordinary members). The point of these
 * tests is that EVERY sign-up path honours it — the magic-link flow creates the
 * account as soon as the address is submitted, so a check that only ran in the
 * password registration would be useless there.
 *
 * Covered: no verifications → no-op; a refusing verification stops password
 * registration and magic-link sign-up without writing a user row or running a
 * post-register action; existing accounts keep logging in; an allowing
 * verification lets the sign-up through; the route answers 403 with the
 * verification's message.
 */

const BLOCKED_EMAIL = "test-prereg-blocked@blocked.example";
const ALLOWED_EMAIL = "test-prereg-allowed@symbiosika.de";
const EXISTING_EMAIL = "test-prereg-existing@blocked.example";
const ALL_TEST_EMAILS = [BLOCKED_EMAIL, ALLOWED_EMAIL, EXISTING_EMAIL];

const REASON = "Addresses of this domain cannot sign up";

// Workaround for the Bun + postgres hang on `expect(promise).rejects.toThrow()`
// (https://github.com/oven-sh/bun/issues/19130). Assert rejection manually.
const expectReject = async (p: Promise<unknown>): Promise<unknown> => {
  let error: unknown;
  let threw = false;
  try {
    await p;
  } catch (err) {
    threw = true;
    error = err;
  }
  expect(threw).toBe(true);
  return error;
};

const userExists = async (email: string) =>
  (await getDb().select().from(users).where(eq(users.email, email))).length >
  0;

/** Refuses every address of the `blocked.example` domain. */
const blockDomain = async (email: string) =>
  email.endsWith("@blocked.example")
    ? { success: false, message: REASON }
    : { success: true };

let postRegisterCalls: string[] = [];

/** Hooks are process-wide; each test starts from a known registry. */
const resetHooks = () => {
  preRegisterCustomVerifications.length = 0;
  postRegisterActions.length = 0;
  postRegisterCalls = [];
  registerPostRegisterAction(async (_userId, email) => {
    postRegisterCalls.push(email);
  });
};

const cleanup = async () => {
  await getDb().delete(users).where(inArray(users.email, ALL_TEST_EMAILS));
};

let originalConsoleMode: boolean;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();
  // The route test sends a magic link; keep it local.
  const svc = smtpService as unknown as { consoleMode: boolean };
  originalConsoleMode = svc.consoleMode;
  svc.consoleMode = true;
});

beforeEach(async () => {
  resetHooks();
  await cleanup();
});

afterAll(async () => {
  preRegisterCustomVerifications.length = 0;
  postRegisterActions.length = 0;
  (smtpService as unknown as { consoleMode: boolean }).consoleMode =
    originalConsoleMode;
  try {
    await cleanup();
  } catch (err) {
    console.warn("[pre-register.test] cleanup failed:", err);
  }
});

describe("runPreRegisterVerifications", () => {
  it("is a no-op without registered verifications", async () => {
    await runPreRegisterVerifications(BLOCKED_EMAIL, {});
  });

  it("throws a PreRegisterVerificationError carrying the reason", async () => {
    registerPreRegisterCustomVerification(blockDomain);
    const err = await expectReject(
      runPreRegisterVerifications(BLOCKED_EMAIL, {})
    );
    expect(err).toBeInstanceOf(PreRegisterVerificationError);
    expect((err as PreRegisterVerificationError).reason).toBe(REASON);
  });

  it("falls back to a default reason when the verification gives none", async () => {
    registerPreRegisterCustomVerification(async () => ({ success: false }));
    const err = await expectReject(
      runPreRegisterVerifications(ALLOWED_EMAIL, {})
    );
    expect((err as PreRegisterVerificationError).reason.length).toBeGreaterThan(
      0
    );
  });

  it("passes email and meta to the verification", async () => {
    let seen: { email: string; meta: any } | null = null;
    registerPreRegisterCustomVerification(async (email, meta) => {
      seen = { email, meta };
      return { success: true };
    });
    await runPreRegisterVerifications(ALLOWED_EMAIL, { invitationCode: "x" });
    expect(seen!).toEqual({
      email: ALLOWED_EMAIL,
      meta: { invitationCode: "x" },
    });
  });
});

describe("password registration (LocalAuth.register)", () => {
  it("refuses a blocked address without creating an account", async () => {
    registerPreRegisterCustomVerification(blockDomain);
    const err = await expectReject(
      LocalAuth.register(BLOCKED_EMAIL, "some-password", false, {})
    );
    expect(err).toBeInstanceOf(PreRegisterVerificationError);
    expect(await userExists(BLOCKED_EMAIL)).toBe(false);
    expect(postRegisterCalls).toEqual([]);
  });
});

describe("magic-link sign-up (createMagicLinkToken)", () => {
  it("refuses a blocked address without creating an account", async () => {
    registerPreRegisterCustomVerification(blockDomain);
    const err = await expectReject(
      createMagicLinkToken(BLOCKED_EMAIL, "login", true)
    );
    expect(err).toBeInstanceOf(PreRegisterVerificationError);
    expect(await userExists(BLOCKED_EMAIL)).toBe(false);
    expect(postRegisterCalls).toEqual([]);
  });

  it("lets an allowed address sign up", async () => {
    registerPreRegisterCustomVerification(blockDomain);
    const token = await createMagicLinkToken(ALLOWED_EMAIL, "login", true);
    expect(token.length).toBeGreaterThan(0);
    expect(await userExists(ALLOWED_EMAIL)).toBe(true);
    expect(postRegisterCalls).toEqual([ALLOWED_EMAIL]);
  });

  it("does not affect the login of an existing account", async () => {
    await getDb().insert(users).values({
      email: EXISTING_EMAIL,
      firstname: "",
      surname: "",
      extUserId: "",
      emailVerified: true,
    });
    registerPreRegisterCustomVerification(blockDomain);
    const token = await createMagicLinkToken(EXISTING_EMAIL, "login", true);
    expect(token.length).toBeGreaterThan(0);
    expect(postRegisterCalls).toEqual([]);
  });
});

describe("GET /user/send-magic-link", () => {
  const app: SymbiosikaFrameworkHonoApp = new Hono();
  definePublicUserRoutes(app, "/api");

  it("answers 403 with the verification's message", async () => {
    registerPreRegisterCustomVerification(blockDomain);
    const response = await app.request(
      "/api/user/send-magic-link?email=" +
        encodeURIComponent(BLOCKED_EMAIL) +
        "&createUserIfMissing=true",
      { method: "GET" }
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(REASON);
    expect(await userExists(BLOCKED_EMAIL)).toBe(false);
  });
});
