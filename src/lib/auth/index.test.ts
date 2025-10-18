import { describe, it, expect, beforeAll } from "bun:test";
import { LocalAuth } from "./index";
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../db/db-connection";
import { eq } from "drizzle-orm";
import { invitationCodes, users } from "../db/db-schema";
import { createMagicLinkToken } from "./magic-link";
import { getUserByEmail } from "../usermanagement/user";

const TEST_EMAIL = "test-user@symbiosika.de";
const TEST_PASSWORD = "test-password";
const TEST_OVERWRITE_PASSWORD = "test-overwrite-password";
const TEST_INVITATION_CODE = "test-code";

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();
  await getDb().delete(users).where(eq(users.email, TEST_EMAIL));
  await getDb()
    .insert(invitationCodes)
    .values({
      code: TEST_INVITATION_CODE,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [invitationCodes.code],
      set: { isActive: true },
    });
});

describe("LocalAuth", async () => {
  describe("register and authorize", () => {
    it("should register, authorize, and handle incorrect credentials sequentially", async () => {
      // Register a new user
      const email = TEST_EMAIL;
      const password = TEST_PASSWORD;

      // Reject a registration WITHOUT a invitation code
      expect(LocalAuth.register(email, password, false, {})).rejects.toThrow(
        "No invitation code provided but is required"
      );

      // Register a new user WITH a invitation code
      const user = await LocalAuth.register(email, password, false, {
        invitationCode: TEST_INVITATION_CODE,
      });
      expect(user).toBeDefined();
      expect(user.email).toBe(email);

      // set mail verified to true
      await getDb()
        .update(users)
        .set({ emailVerified: true })
        .where(eq(users.id, user.id));

      // Authorize the user with correct credentials
      const authorizedUser = await LocalAuth.authorize(email, password);
      expect(authorizedUser).toBeDefined();
      expect(authorizedUser.email).toBe(email);

      // Attempt to authorize with incorrect credentials
      const wrongPassword = "wrong_password";
      expect(LocalAuth.authorize(email, wrongPassword)).rejects.toThrow(
        "passwords do not match"
      );
    });
  });

  describe("login", () => {
    it("should login a user with correct credentials", async () => {
      const email = TEST_EMAIL;
      const password = TEST_PASSWORD;
      const session = await LocalAuth.login(email, password);
      expect(session.token).toBeDefined();
    });
  });

  describe("loginWithMagicLink", () => {
    it("should login a user with a valid magic link token", async () => {
      const token = await createMagicLinkToken(TEST_EMAIL, "login");
      const result = await LocalAuth.loginWithMagicLink(token);
      expect(result).toBeDefined();
    });
  });

  describe("setNewPassword", () => {
    it("should set a new password for the user", async () => {
      const user = await getUserByEmail(TEST_EMAIL);
      const newPassword = TEST_OVERWRITE_PASSWORD;
      const result = await LocalAuth.setNewPassword(user.id, newPassword);
      expect(result).toBeDefined();
    });
  });

  describe("changePassword", () => {
    it("should change the user's password", async () => {
      const oldPassword = TEST_OVERWRITE_PASSWORD;
      const newPassword = TEST_PASSWORD;
      const result = await LocalAuth.changePassword(
        TEST_EMAIL,
        oldPassword,
        newPassword
      );
      expect(result).toBeDefined();
    });
  });

  describe("refreshToken", () => {
    it("should refresh the user's token", async () => {
      const user = await getUserByEmail(TEST_EMAIL);
      const result = await LocalAuth.refreshToken(user.id);
      expect(result.token).toBeDefined();
    });
  });
});
