import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../db/db-connection";
import { eq, inArray } from "drizzle-orm";
import { emailChangeRequests, users } from "../db/db-schema";
import { confirmEmailChange, requestEmailChange } from "./email-change";
import {
  postEmailChangeActions,
  preEmailChangeVerifications,
  registerPostEmailChangeAction,
  registerPreEmailChangeVerification,
} from "./actions";
import type { EmailChangeContext } from "../../types";

/**
 * The hooks of the e-mail change flow.
 *
 * They exist because the framework can only judge the technical side of a new
 * address (well-formed, not the current one, not taken). Which addresses a
 * particular account may move to, and what has to be recorded when it does, is
 * app knowledge — see `customPreEmailChangeVerifications` /
 * `customPostEmailChangeActions` in the server config.
 *
 * Covered here: a verification can refuse a request (and nothing is written or
 * mailed), it sees the actual addresses, an allowing one lets the request
 * through, a post action sees the confirmed change, and a throwing post action
 * does not turn a completed change into an error.
 */

const USER_EMAIL = "test-ec-hooks@symbiosika.de";
const NEW_EMAIL = "test-ec-hooks-new@symbiosika.de";
const ALL_TEST_EMAILS = [USER_EMAIL, NEW_EMAIL];

// Workaround for the Bun + postgres hang on `expect(promise).rejects.toThrow()`
// (https://github.com/oven-sh/bun/issues/19130). Assert rejection manually.
const expectReject = async (p: Promise<unknown>): Promise<string> => {
  let message = "";
  let threw = false;
  try {
    await p;
  } catch (err) {
    threw = true;
    message = err + "";
  }
  expect(threw).toBe(true);
  return message;
};

let userId = "";

const cleanup = async () => {
  await getDb().delete(users).where(inArray(users.email, ALL_TEST_EMAILS));
};

/** Hooks are process-wide; each test starts from an empty registry. */
const clearHooks = () => {
  preEmailChangeVerifications.length = 0;
  postEmailChangeActions.length = 0;
};

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();
});

beforeEach(async () => {
  clearHooks();
  await cleanup();
  const created = await getDb()
    .insert(users)
    .values({
      email: USER_EMAIL,
      firstname: "Hook",
      surname: "Tester",
      emailVerified: false,
      extUserId: "",
    })
    .returning({ id: users.id });
  userId = created[0]!.id;
});

afterAll(async () => {
  clearHooks();
  try {
    await cleanup();
  } catch (err) {
    console.warn("[email-change-hooks.test] cleanup failed:", err);
  }
});

describe("email change hooks", () => {
  it("lets a verification refuse the request, with its own message", async () => {
    registerPreEmailChangeVerification(async () => ({
      success: false,
      message: "Not allowed for this account",
    }));

    const message = await expectReject(
      requestEmailChange(userId, NEW_EMAIL, false)
    );
    expect(message).toContain("Not allowed for this account");

    // Refused before anything was written – so no link can be out there.
    const rows = await getDb()
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, userId));
    expect(rows.length).toBe(0);
  });

  it("hands the verification the current and the requested address", async () => {
    const seen: EmailChangeContext[] = [];
    registerPreEmailChangeVerification(async (context) => {
      seen.push(context);
      return { success: true };
    });

    await requestEmailChange(userId, NEW_EMAIL.toUpperCase(), false);

    expect(seen.length).toBe(1);
    expect(seen[0]?.userId).toBe(userId);
    expect(seen[0]?.oldEmail).toBe(USER_EMAIL);
    // Normalized, i.e. the address as it would be stored.
    expect(seen[0]?.newEmail).toBe(NEW_EMAIL);
  });

  it("runs every verification and keeps the request when all of them pass", async () => {
    let calls = 0;
    registerPreEmailChangeVerification(async () => {
      calls++;
      return { success: true };
    });
    registerPreEmailChangeVerification(async () => {
      calls++;
      return { success: true };
    });

    const request = await requestEmailChange(userId, NEW_EMAIL, false);

    expect(calls).toBe(2);
    expect(request.newEmail).toBe(NEW_EMAIL);
  });

  it("uses a default message when a verification refuses without one", async () => {
    registerPreEmailChangeVerification(async () => ({ success: false }));

    const message = await expectReject(
      requestEmailChange(userId, NEW_EMAIL, false)
    );
    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain("cannot be used");
  });

  it("tells a post action about the confirmed change", async () => {
    const seen: EmailChangeContext[] = [];
    registerPostEmailChangeAction(async (context) => {
      seen.push(context);
    });

    const { token } = await requestEmailChange(userId, NEW_EMAIL, false);
    await confirmEmailChange(token);

    expect(seen.length).toBe(1);
    expect(seen[0]?.userId).toBe(userId);
    expect(seen[0]?.oldEmail).toBe(USER_EMAIL);
    expect(seen[0]?.newEmail).toBe(NEW_EMAIL);
  });

  it("does not fail a completed change when a post action throws", async () => {
    registerPostEmailChangeAction(async () => {
      throw new Error("bookkeeping is down");
    });
    let secondRan = false;
    registerPostEmailChangeAction(async () => {
      secondRan = true;
    });

    const { token } = await requestEmailChange(userId, NEW_EMAIL, false);
    const result = await confirmEmailChange(token);

    expect(result.newEmail).toBe(NEW_EMAIL);
    // A broken observer must not stop the others …
    expect(secondRan).toBe(true);
    // … and the change itself stands.
    const account = await getDb()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    expect(account[0]?.email).toBe(NEW_EMAIL);
  });

  it("leaves the flow unchanged when no hooks are registered", async () => {
    const { token } = await requestEmailChange(userId, NEW_EMAIL, false);
    const result = await confirmEmailChange(token);
    expect(result.newEmail).toBe(NEW_EMAIL);
  });
});
