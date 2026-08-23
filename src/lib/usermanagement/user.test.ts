import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../db/db-connection";
import { eq, sql } from "drizzle-orm";
import { users } from "../db/db-schema";
import { updateUser } from "./user";

/**
 * `updateUser` derives two columns from the phone number:
 * `phone_number_as_number` (the WhatsApp / lookup form, unique-indexed) and
 * `phone_number_verified` (set by the PIN flow). Both are only allowed to move
 * when the patch actually carries a phone number — a patch that changes a name
 * or an e-mail address says nothing about the phone and must leave the
 * verification alone.
 */

const TEST_EMAIL = "update-user-phone@symbiosika.de";
const PHONE = "+49 158 997779997";
const PHONE_AS_NUMBER = 49158997779997;

let userId: string;

const cleanup = async () => {
  await getDb()
    .delete(users)
    .where(sql`lower(${users.email}) = ${TEST_EMAIL}`);
};

/** Verified starting point: number stored, mirror set, flag true. */
const givenVerifiedPhone = async () => {
  await getDb()
    .update(users)
    .set({
      phoneNumber: PHONE,
      phoneNumberAsNumber: PHONE_AS_NUMBER,
      phoneNumberVerified: true,
    })
    .where(eq(users.id, userId));
};

const readUser = async () => {
  const [row] = await getDb()
    .select({
      email: users.email,
      firstname: users.firstname,
      phoneNumber: users.phoneNumber,
      phoneNumberAsNumber: users.phoneNumberAsNumber,
      phoneNumberVerified: users.phoneNumberVerified,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row!;
};

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();
  await cleanup();

  const [created] = await getDb()
    .insert(users)
    .values({
      email: TEST_EMAIL,
      firstname: "Phone",
      surname: "Tester",
      emailVerified: true,
      extUserId: "",
    })
    .returning({ id: users.id });
  userId = created!.id;
});

afterAll(async () => {
  await cleanup();
});

describe("updateUser", () => {
  it("keeps a verified phone number untouched when the patch does not mention it", async () => {
    await givenVerifiedPhone();

    await updateUser(userId, { firstname: "Renamed" });

    const after = await readUser();
    expect(after.firstname).toBe("Renamed");
    // The regression this test exists for: an unrelated patch used to reset
    // the flag (and would have dropped the numeric mirror with it).
    expect(after.phoneNumberVerified).toBe(true);
    expect(after.phoneNumberAsNumber).toBe(PHONE_AS_NUMBER);
    expect(after.phoneNumber).toBe(PHONE);
  });

  it("keeps the verification when the same number is submitted again", async () => {
    await givenVerifiedPhone();

    await updateUser(userId, { phoneNumber: PHONE });

    const after = await readUser();
    expect(after.phoneNumberVerified).toBe(true);
    expect(after.phoneNumberAsNumber).toBe(PHONE_AS_NUMBER);
  });

  it("revokes the verification and re-derives the mirror for a new number", async () => {
    await givenVerifiedPhone();

    await updateUser(userId, { phoneNumber: "+49 160 1234567" });

    const after = await readUser();
    expect(after.phoneNumberVerified).toBe(false);
    expect(after.phoneNumberAsNumber).toBe(491601234567);
  });

  it("clears the numeric mirror when the number is removed", async () => {
    await givenVerifiedPhone();

    await updateUser(userId, { phoneNumber: null });

    const after = await readUser();
    expect(after.phoneNumber).toBeNull();
    // A leftover mirror would keep routing the verification PIN to the removed
    // number and keep it blocked for every other user (unique index).
    expect(after.phoneNumberAsNumber).toBeNull();
    expect(after.phoneNumberVerified).toBe(false);
  });

  it("stores no mirror for a number without parsable digits", async () => {
    await givenVerifiedPhone();

    // `NaN` in the bigint column would fail the statement outright.
    await updateUser(userId, { phoneNumber: "keine Nummer" });

    const after = await readUser();
    expect(after.phoneNumber).toBe("keine Nummer");
    expect(after.phoneNumberAsNumber).toBeNull();
    expect(after.phoneNumberVerified).toBe(false);
  });

  it("normalizes the e-mail address without touching the phone columns", async () => {
    await givenVerifiedPhone();

    await updateUser(userId, { email: `  ${TEST_EMAIL.toUpperCase()} ` });

    const after = await readUser();
    expect(after.email).toBe(TEST_EMAIL);
    expect(after.phoneNumberVerified).toBe(true);
    expect(after.phoneNumberAsNumber).toBe(PHONE_AS_NUMBER);
  });
});
