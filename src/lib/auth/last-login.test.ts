import { describe, test, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import {
  initTests,
  TEST_ADMIN_USER,
  TEST_ORG1_USER_1,
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { users } from "../db/db-schema";
import { generateUserSessionJwt } from "./index";
import { createImpersonationSession } from "./impersonation";

const readLastLogin = async (userId: string) => {
  const [row] = await getDb()
    .select({ lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(eq(users.id, userId));
  return row?.lastLoginAt ?? null;
};

const resetLastLogin = (userId: string) =>
  getDb().update(users).set({ lastLoginAt: null }).where(eq(users.id, userId));

const sessionUser = (u: typeof TEST_ORG1_USER_1) => ({
  id: u.id,
  email: u.email,
  firstname: u.firstname,
  surname: u.surname,
});

describe("users.lastLoginAt", () => {
  beforeAll(async () => {
    await initTests();
  });

  test("a login session stamps lastLoginAt", async () => {
    await resetLastLogin(TEST_ORG1_USER_1.id);
    const before = Date.now();
    await generateUserSessionJwt(sessionUser(TEST_ORG1_USER_1));
    const stamped = await readLastLogin(TEST_ORG1_USER_1.id);
    expect(stamped).not.toBeNull();
    expect(new Date(stamped!).getTime()).toBeGreaterThanOrEqual(
      before - 5000
    );
  });

  test("a token refresh (recordLogin: false) does not count", async () => {
    await resetLastLogin(TEST_ORG1_USER_1.id);
    await generateUserSessionJwt(
      sessionUser(TEST_ORG1_USER_1),
      undefined,
      undefined,
      { recordLogin: false }
    );
    expect(await readLastLogin(TEST_ORG1_USER_1.id)).toBeNull();
  });

  test("an impersonation session does not count as the user's login", async () => {
    await resetLastLogin(TEST_ORG1_USER_1.id);
    await createImpersonationSession({
      targetUserId: TEST_ORG1_USER_1.id,
      actor: { id: TEST_ADMIN_USER.id, email: TEST_ADMIN_USER.email },
    });
    expect(await readLastLogin(TEST_ORG1_USER_1.id)).toBeNull();
  });
});
