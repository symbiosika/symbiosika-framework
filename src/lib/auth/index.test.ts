import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { LocalAuth } from "./index";
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../db/db-connection";
import { eq, inArray } from "drizzle-orm";
import { invitationCodes, users } from "../db/db-schema";
import { createMagicLinkToken } from "./magic-link";
import { getUserByEmail } from "../usermanagement/user";

const TEST_EMAIL = "test-user@symbiosika.de";
const TEST_PASSWORD = "test-password";
const TEST_OVERWRITE_PASSWORD = "test-overwrite-password";
const TEST_INVITATION_CODE = "test-code";

// All emails the auth tests may create / touch. Kept in one place so both the
// pre-test cleanup and the post-test cleanup stay in sync.
const ALL_TEST_EMAILS = [
  TEST_EMAIL,
  "test-magic-register@symbiosika.de",
  "test-magic-register-plain@symbiosika.de",
  "test-custom-register@symbiosika.de",
];

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();
  // Start from a clean slate for all users this test suite may create.
  await getDb().delete(users).where(inArray(users.email, ALL_TEST_EMAILS));
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

// IMPORTANT: Without this cleanup an active invitation code would remain in the
// DB after the test run, which in turn causes
// `checkIfInvitationCodeIsNeededToRegister()` to return `true` globally and
// breaks interactive registration in the dev environment.
afterAll(async () => {
  try {
    await getDb()
      .delete(invitationCodes)
      .where(eq(invitationCodes.code, TEST_INVITATION_CODE));
    await getDb().delete(users).where(inArray(users.email, ALL_TEST_EMAILS));
  } catch (err) {
    console.warn("[auth.test] cleanup failed:", err);
  }
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
      if (!user) {
        throw new Error("User is undefined");
      }
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

  describe("customRegisterData persistence (magic-link register path)", () => {
    const MAGIC_EMAIL = "test-magic-register@symbiosika.de";

    it("persists customRegisterData on users.meta when the user is created via createMagicLinkToken(createUserIfMissing=true) and forwards the meta to post-register actions", async () => {
      // Make sure no prior user exists
      await getDb().delete(users).where(eq(users.email, MAGIC_EMAIL));

      const capturedCalls: Array<{
        userId: string;
        email: string;
        meta: any;
      }> = [];
      const { registerPostRegisterAction, postRegisterActions } = await import(
        "./actions"
      );
      const capturingAction = async (
        userId: string,
        email: string,
        meta: any
      ) => {
        capturedCalls.push({ userId, email, meta });
      };
      registerPostRegisterAction(capturingAction);

      try {
        await createMagicLinkToken(
          MAGIC_EMAIL,
          "login",
          /* createUserIfMissing */ true,
          /* invitationCode */ TEST_INVITATION_CODE,
          /* customRegisterData */ {
            adviceCenterNumber: "0123",
            source: "qr-code",
          }
        );

        // Verify user was created with meta.customRegisterData persisted.
        const [row] = await getDb()
          .select()
          .from(users)
          .where(eq(users.email, MAGIC_EMAIL));
        expect(row).toBeDefined();
        expect(row?.meta).toBeTruthy();
        expect((row?.meta as any)?.customRegisterData?.adviceCenterNumber).toBe(
          "0123"
        );
        expect((row?.meta as any)?.customRegisterData?.source).toBe("qr-code");

        // Post-register action must have been called with the same meta.
        const captured = capturedCalls.find((c) => c.email === MAGIC_EMAIL);
        expect(captured).toBeDefined();
        expect(captured?.meta?.customRegisterData?.adviceCenterNumber).toBe(
          "0123"
        );
        expect(captured?.meta?.invitationCode).toBe(TEST_INVITATION_CODE);
      } finally {
        const idx = postRegisterActions.indexOf(capturingAction);
        if (idx >= 0) postRegisterActions.splice(idx, 1);
        await getDb().delete(users).where(eq(users.email, MAGIC_EMAIL));
      }
    });

    it("does not set meta when no customRegisterData is given (magic-link path)", async () => {
      const EMAIL_NO_DATA = "test-magic-register-plain@symbiosika.de";
      await getDb().delete(users).where(eq(users.email, EMAIL_NO_DATA));

      try {
        await createMagicLinkToken(
          EMAIL_NO_DATA,
          "login",
          true,
          TEST_INVITATION_CODE
        );

        const [row] = await getDb()
          .select()
          .from(users)
          .where(eq(users.email, EMAIL_NO_DATA));
        expect(row).toBeDefined();
        // meta should be null / falsy when no customRegisterData is provided.
        expect(row?.meta).toBeFalsy();
      } finally {
        await getDb().delete(users).where(eq(users.email, EMAIL_NO_DATA));
      }
    });
  });

  describe("customRegisterData persistence", () => {
    const CUSTOM_REG_EMAIL = "test-custom-register@symbiosika.de";

    it("persists customRegisterData on users.meta and forwards it to post-register actions", async () => {
      // Clean any leftover
      await getDb().delete(users).where(eq(users.email, CUSTOM_REG_EMAIL));

      // Register a new post-register action that captures the forwarded meta
      const capturedCalls: Array<{
        userId: string;
        email: string;
        meta: any;
      }> = [];
      const { registerPostRegisterAction, postRegisterActions } = await import(
        "./actions"
      );
      const capturingAction = async (
        userId: string,
        email: string,
        meta: any
      ) => {
        capturedCalls.push({ userId, email, meta });
      };
      registerPostRegisterAction(capturingAction);

      try {
        const user = await LocalAuth.register(
          CUSTOM_REG_EMAIL,
          "some-password",
          false,
          {
            invitationCode: TEST_INVITATION_CODE,
            customRegisterData: { adviceCenterNumber: "1234", source: "qr" },
          }
        );
        expect(user).toBeDefined();

        // Verify meta got persisted on the user row.
        const [row] = await getDb()
          .select()
          .from(users)
          .where(eq(users.id, user!.id));
        expect(row?.meta).toBeTruthy();
        expect((row?.meta as any)?.customRegisterData?.adviceCenterNumber).toBe(
          "1234"
        );
        expect((row?.meta as any)?.customRegisterData?.source).toBe("qr");

        // Verify our capturing post-register action received the meta.
        const captured = capturedCalls.find(
          (c) => c.email === CUSTOM_REG_EMAIL
        );
        expect(captured).toBeDefined();
        expect(captured?.meta?.customRegisterData?.adviceCenterNumber).toBe(
          "1234"
        );
      } finally {
        // Remove our capturing action so it does not leak into later tests.
        const idx = postRegisterActions.indexOf(capturingAction);
        if (idx >= 0) postRegisterActions.splice(idx, 1);
        await getDb().delete(users).where(eq(users.email, CUSTOM_REG_EMAIL));
      }
    });
  });
});
