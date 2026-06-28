import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../db/db-connection";
import { and, eq } from "drizzle-orm";
import * as crypto from "crypto";
import { emailLoginCodes, users } from "../db/db-schema";
import {
  createEmailLoginCode,
  verifyEmailLoginCode,
  sendEmailLoginCode,
} from "./email-otp";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

const TEST_EMAIL = "test-otp@symbiosika.de";
const UNKNOWN_EMAIL = "test-otp-unknown@symbiosika.de";

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");

// Workaround for the Bun + postgres hang on `expect(promise).rejects.toThrow()`
// (https://github.com/oven-sh/bun/issues/19130). Assert rejection manually.
const expectReject = async (p: Promise<unknown>) => {
  let threw = false;
  try {
    await p;
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
};

const cleanup = async () => {
  await getDb()
    .delete(emailLoginCodes)
    .where(eq(emailLoginCodes.email, TEST_EMAIL));
  await getDb()
    .delete(emailLoginCodes)
    .where(eq(emailLoginCodes.email, UNKNOWN_EMAIL));
  await getDb().delete(users).where(eq(users.email, TEST_EMAIL));
};

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();
  await cleanup();
  await getDb().insert(users).values({
    email: TEST_EMAIL,
    firstname: "Otp",
    surname: "Tester",
    emailVerified: true,
    extUserId: "",
  });
});

afterAll(async () => {
  await cleanup();
});

describe("email-otp", () => {
  it("stores only the hash, never the plaintext code", async () => {
    const code = await createEmailLoginCode(TEST_EMAIL);
    expect(code).toMatch(/^\d{6}$/);

    const rows = await getDb()
      .select()
      .from(emailLoginCodes)
      .where(eq(emailLoginCodes.email, TEST_EMAIL));
    expect(rows.length).toBe(1);
    expect(rows[0]!.codeHash).not.toBe(code);
    expect(rows[0]!.codeHash).toBe(sha256(code));
  });

  it("verifies a correct code exactly once (single-use)", async () => {
    const code = await createEmailLoginCode(TEST_EMAIL);

    const result = await verifyEmailLoginCode(TEST_EMAIL, code);
    expect(result.email).toBe(TEST_EMAIL);
    expect(result.userId).toBeTruthy();

    // Re-using the same code must fail.
    await expectReject(verifyEmailLoginCode(TEST_EMAIL, code));
  });

  it("rejects a wrong code and invalidates after max attempts", async () => {
    const code = await createEmailLoginCode(TEST_EMAIL);
    const max = _GLOBAL_SERVER_CONFIG.oauth2.emailLoginCodeMaxAttempts;

    // Exhaust all attempts with a wrong code.
    for (let i = 0; i < max; i++) {
      await expectReject(verifyEmailLoginCode(TEST_EMAIL, "000000"));
    }

    // Even the correct code is now invalid (code was burned).
    await expectReject(verifyEmailLoginCode(TEST_EMAIL, code));
  });

  it("rejects an expired code", async () => {
    const code = await createEmailLoginCode(TEST_EMAIL);
    // Force expiry into the past.
    await getDb()
      .update(emailLoginCodes)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(emailLoginCodes.email, TEST_EMAIL));

    await expectReject(verifyEmailLoginCode(TEST_EMAIL, code));
  });

  it("invalidates the previous code when a new one is created", async () => {
    const first = await createEmailLoginCode(TEST_EMAIL);
    const second = await createEmailLoginCode(TEST_EMAIL);
    expect(first).not.toBe(second);

    // Only the newest code is active.
    await expectReject(verifyEmailLoginCode(TEST_EMAIL, first));
    const ok = await verifyEmailLoginCode(TEST_EMAIL, second);
    expect(ok.email).toBe(TEST_EMAIL);
  });

  it("does not create a code for an unknown email (no enumeration)", async () => {
    await sendEmailLoginCode(UNKNOWN_EMAIL);
    const rows = await getDb()
      .select()
      .from(emailLoginCodes)
      .where(eq(emailLoginCodes.email, UNKNOWN_EMAIL));
    expect(rows.length).toBe(0);
  });
});
