import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../db/db-connection";
import { eq, inArray } from "drizzle-orm";
import * as crypto from "crypto";
import { emailChangeRequests, users } from "../db/db-schema";
import {
  buildEmailChangeConfirmLink,
  cancelEmailChangeRequest,
  confirmEmailChange,
  getEmailChangeRequestByToken,
  getPendingEmailChangeRequest,
  requestEmailChange,
} from "./email-change";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

const USER_EMAIL = "test-email-change@symbiosika.de";
const OTHER_EMAIL = "test-email-change-other@symbiosika.de";
const NEW_EMAIL = "test-email-change-new@symbiosika.de";
const SECOND_NEW_EMAIL = "test-email-change-new2@symbiosika.de";

const ALL_TEST_EMAILS = [
  USER_EMAIL,
  OTHER_EMAIL,
  NEW_EMAIL,
  SECOND_NEW_EMAIL,
  NEW_EMAIL.toUpperCase(),
];

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");

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
let otherUserId = "";

const cleanup = async () => {
  await getDb().delete(users).where(inArray(users.email, ALL_TEST_EMAILS));
};

/** Fresh accounts before every test so no test depends on another's writes. */
const createTestUsers = async () => {
  await cleanup();
  const created = await getDb()
    .insert(users)
    .values([
      {
        email: USER_EMAIL,
        firstname: "Change",
        surname: "Tester",
        emailVerified: false,
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
  otherUserId = created.find((u) => u.email === OTHER_EMAIL)!.id;
};

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();
});

beforeEach(async () => {
  await createTestUsers();
});

afterAll(async () => {
  try {
    await cleanup();
  } catch (err) {
    console.warn("[email-change.test] cleanup failed:", err);
  }
});

describe("email change requests", () => {
  it("parks the request without touching the account and stores only the token hash", async () => {
    const request = await requestEmailChange(userId, NEW_EMAIL, false);

    expect(request.newEmail).toBe(NEW_EMAIL);
    expect(request.oldEmail).toBe(USER_EMAIL);
    expect(request.token.length).toBeGreaterThan(20);

    // The account itself is unchanged until the new address is confirmed.
    const account = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    expect(account[0]!.email).toBe(USER_EMAIL);
    expect(account[0]!.emailVerified).toBe(false);

    const rows = await getDb()
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, userId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tokenHash).toBe(sha256(request.token));
    // The plaintext token must not be recoverable from the row.
    expect(JSON.stringify(rows[0])).not.toContain(request.token);
  });

  it("normalizes the requested address", async () => {
    const request = await requestEmailChange(
      userId,
      `  ${NEW_EMAIL.toUpperCase()} `,
      false
    );
    expect(request.newEmail).toBe(NEW_EMAIL);

    const confirmed = await confirmEmailChange(request.token);
    expect(confirmed.newEmail).toBe(NEW_EMAIL);
  });

  it("rejects an invalid, unchanged or already used address", async () => {
    expect(
      await expectReject(requestEmailChange(userId, "not-an-email", false))
    ).toContain("Invalid email address");

    expect(
      await expectReject(requestEmailChange(userId, USER_EMAIL, false))
    ).toContain("current one");

    expect(
      await expectReject(requestEmailChange(userId, OTHER_EMAIL, false))
    ).toContain("already in use");

    // None of the rejected attempts may leave a request behind.
    const rows = await getDb()
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, userId));
    expect(rows.length).toBe(0);
  });

  it("keeps only one open request per user", async () => {
    const first = await requestEmailChange(userId, NEW_EMAIL, false);
    const second = await requestEmailChange(userId, SECOND_NEW_EMAIL, false);

    const pending = await getPendingEmailChangeRequest(userId);
    expect(pending?.newEmail).toBe(SECOND_NEW_EMAIL);

    // The superseded link stops working.
    await expectReject(getEmailChangeRequestByToken(first.token));

    const info = await getEmailChangeRequestByToken(second.token);
    expect(info.newEmail).toBe(SECOND_NEW_EMAIL);
  });

  it("throttles repeated confirmation mails for the same address", async () => {
    await requestEmailChange(userId, NEW_EMAIL, false);

    expect(
      await expectReject(requestEmailChange(userId, NEW_EMAIL, false))
    ).toContain("just sent");

    // A different target address is not throttled.
    const other = await requestEmailChange(userId, SECOND_NEW_EMAIL, false);
    expect(other.newEmail).toBe(SECOND_NEW_EMAIL);
  });

  it("reads the request by token without consuming it", async () => {
    const request = await requestEmailChange(userId, NEW_EMAIL, false);

    const first = await getEmailChangeRequestByToken(request.token);
    const second = await getEmailChangeRequestByToken(request.token);
    expect(first.newEmail).toBe(NEW_EMAIL);
    expect(second.newEmail).toBe(NEW_EMAIL);

    // Still unchanged: reading is not confirming.
    const account = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    expect(account[0]!.email).toBe(USER_EMAIL);
  });

  it("builds a confirmation link pointing at the configured page", () => {
    const link = buildEmailChangeConfirmLink("abc/123");
    expect(link).toBe(
      `${_GLOBAL_SERVER_CONFIG.baseUrl}${_GLOBAL_SERVER_CONFIG.verifyEmailChangeUrl}?token=abc%2F123`
    );
  });
});

describe("email change confirmation", () => {
  it("applies the change, verifies the address and consumes the token", async () => {
    const request = await requestEmailChange(userId, NEW_EMAIL, false);

    const result = await confirmEmailChange(request.token);
    expect(result.userId).toBe(userId);
    expect(result.oldEmail).toBe(USER_EMAIL);
    expect(result.newEmail).toBe(NEW_EMAIL);

    const account = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    expect(account[0]!.email).toBe(NEW_EMAIL);
    // Clicking the link in the new mailbox IS the verification.
    expect(account[0]!.emailVerified).toBe(true);

    // Single use: the same token cannot be replayed.
    await expectReject(confirmEmailChange(request.token));

    // The row is kept as a consumed record until it expires, and no longer
    // counts as pending.
    const rows = await getDb()
      .select()
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, userId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.consumedAt).not.toBeNull();
    expect(await getPendingEmailChangeRequest(userId)).toBeNull();
  });

  it("rejects an unknown or expired token", async () => {
    await expectReject(confirmEmailChange("does-not-exist"));

    const request = await requestEmailChange(userId, NEW_EMAIL, false);
    await getDb()
      .update(emailChangeRequests)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(emailChangeRequests.id, request.id));

    expect(await expectReject(confirmEmailChange(request.token))).toContain(
      "Invalid or expired"
    );

    const account = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    expect(account[0]!.email).toBe(USER_EMAIL);
  });

  it("rejects a request whose target address was claimed in the meantime", async () => {
    const request = await requestEmailChange(userId, NEW_EMAIL, false);

    // Another account takes the address before the link is clicked.
    await getDb()
      .update(users)
      .set({ email: NEW_EMAIL })
      .where(eq(users.id, otherUserId));

    expect(await expectReject(confirmEmailChange(request.token))).toContain(
      "already in use"
    );

    const account = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    expect(account[0]!.email).toBe(USER_EMAIL);
  });

  it("rejects a request whose account address changed in the meantime", async () => {
    const request = await requestEmailChange(userId, NEW_EMAIL, false);

    // e.g. an admin edit or a second confirmed change.
    await getDb()
      .update(users)
      .set({ email: SECOND_NEW_EMAIL })
      .where(eq(users.id, userId));

    expect(await expectReject(confirmEmailChange(request.token))).toContain(
      "Invalid or expired"
    );

    const account = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    // The newer state wins; the stale request does not revert it.
    expect(account[0]!.email).toBe(SECOND_NEW_EMAIL);
  });

  it("can be cancelled by the user", async () => {
    const request = await requestEmailChange(userId, NEW_EMAIL, false);

    const cancelled = await cancelEmailChangeRequest(userId);
    expect(cancelled).toBe(1);
    expect(await getPendingEmailChangeRequest(userId)).toBeNull();
    await expectReject(confirmEmailChange(request.token));

    // Cancelling again is a no-op, not an error.
    expect(await cancelEmailChangeRequest(userId)).toBe(0);
  });
});
