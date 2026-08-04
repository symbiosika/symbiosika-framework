import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../db/db-connection";
import { eq, sql } from "drizzle-orm";
import { users } from "../db/db-schema";
import { normalizeEmail } from "./email";
import { getUserByEmail } from "../usermanagement/user";

const TEST_EMAIL = "case-test-user@symbiosika.de";

const cleanup = async () => {
  await getDb()
    .delete(users)
    .where(sql`lower(${users.email}) = ${TEST_EMAIL}`);
};

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

describe("normalizeEmail", () => {
  it("lower-cases and trims", () => {
    expect(normalizeEmail("  Max.Mustermann@Example.COM ")).toBe(
      "max.mustermann@example.com"
    );
  });

  it("leaves an already canonical address untouched", () => {
    expect(normalizeEmail("max@example.com")).toBe("max@example.com");
  });
});

describe("case-insensitive email identity", () => {
  it("rejects a second user differing only in case", async () => {
    await getDb().insert(users).values({
      email: TEST_EMAIL,
      firstname: "Case",
      surname: "Tester",
      emailVerified: true,
      extUserId: "",
    });

    // The database — not just the application code — has to refuse this. A
    // plain btree over `text` would accept it as a distinct value, which is
    // exactly how duplicate accounts for one mailbox came about.
    let threw = false;
    try {
      await getDb().insert(users).values({
        email: "Case-Test-User@Symbiosika.de",
        firstname: "Case",
        surname: "Duplicate",
        emailVerified: true,
        extUserId: "",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const rows = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${TEST_EMAIL}`);
    expect(rows.length).toBe(1);
  });

  it("finds a user by a differently capitalised address", async () => {
    const found = await getUserByEmail("CASE-TEST-USER@SYMBIOSIKA.DE");
    expect(found.email).toBe(TEST_EMAIL);
  });

  it("normalizes the address on update", async () => {
    const [row] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, TEST_EMAIL));

    const { updateUser } = await import("../usermanagement/user");
    await updateUser(row!.id, { email: "  Case-Test-User@Symbiosika.DE " });

    const [after] = await getDb()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, row!.id));
    expect(after!.email).toBe(TEST_EMAIL);
  });
});
