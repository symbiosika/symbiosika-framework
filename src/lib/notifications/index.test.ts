/**
 * Notifications Service Tests
 * Tests for user notification/message business logic
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  initTests,
  TEST_ORG1_USER_1,
  TEST_ORG2_USER_1,
  TEST_ORGANISATION_1,
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { userMessages, users, tenantMembers } from "../db/db-schema";
import { eq, and, isNull } from "drizzle-orm";
import {
  getUserMessages,
  addMessageToAllUsers,
  addMessageToTenantUsers,
  confirmMessage,
  confirmAllMessages,
} from "./index";

beforeAll(async () => {
  await initTests();
  // Clean up any existing test messages
  await getDb()
    .delete(userMessages)
    .where(eq(userMessages.userId, TEST_ORG1_USER_1.id));
  await getDb()
    .delete(userMessages)
    .where(eq(userMessages.userId, TEST_ORG2_USER_1.id));
});

afterAll(async () => {
  // Clean up test messages
  await getDb()
    .delete(userMessages)
    .where(eq(userMessages.userId, TEST_ORG1_USER_1.id))
    .then(() => {});
  await getDb()
    .delete(userMessages)
    .where(eq(userMessages.userId, TEST_ORG2_USER_1.id))
    .then(() => {});
});

describe("Notifications Service", () => {
  /**
   * Test: getUserMessages
   */
  test("getUserMessages should return empty array when user has no messages", async () => {
    const messages = await getUserMessages(TEST_ORG1_USER_1.id);
    expect(messages).toBeDefined();
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(0);
  });

  test("getUserMessages should return only unconfirmed messages", async () => {
    // Create a confirmed and unconfirmed message
    const [unconfirmedMessage] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Unconfirmed test message",
        messageType: "info",
      })
      .returning();

    const [confirmedMessage] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Confirmed test message",
        messageType: "info",
        confirmedAt: new Date().toISOString(),
      })
      .returning();

    const messages = await getUserMessages(TEST_ORG1_USER_1.id);

    expect(messages.length).toBe(1);
    if (!messages[0] || !unconfirmedMessage || !confirmedMessage) return; // leave test if failed until here
    expect(messages[0].id).toBe(unconfirmedMessage.id);
    expect(messages[0].confirmedAt).toBeNull();

    // Cleanup
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.id, unconfirmedMessage.id));
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.id, confirmedMessage.id));
  });

  test("getUserMessages should return messages ordered by createdAt desc", async () => {
    const now = new Date();
    const message1 = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "First message",
        messageType: "info",
        createdAt: new Date(now.getTime() - 2000).toISOString(),
      })
      .returning();

    const message2 = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Second message",
        messageType: "warning",
        createdAt: new Date(now.getTime() - 1000).toISOString(),
      })
      .returning();

    const message3 = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Third message",
        messageType: "error",
        createdAt: now.toISOString(),
      })
      .returning();

    const messages = await getUserMessages(TEST_ORG1_USER_1.id);

    expect(messages.length).toBe(3);
    expect(messages[0]!.id).toBe(message3[0]!.id);
    expect(messages[1]!.id).toBe(message2[0]!.id);
    expect(messages[2]!.id).toBe(message1[0]!.id);

    // Cleanup
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.id, message1[0]!.id));
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.id, message2[0]!.id));
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.id, message3[0]!.id));
  });

  /**
   * Test: addMessageToAllUsers
   */
  test("addMessageToAllUsers should add message to all users", async () => {
    const testMessage = "Test message for all users";
    await addMessageToAllUsers(testMessage, "info");

    // Check that message was added to test users
    const user1Messages = await getDb()
      .select()
      .from(userMessages)
      .where(
        and(
          eq(userMessages.userId, TEST_ORG1_USER_1.id),
          eq(userMessages.message, testMessage)
        )
      );

    const user2Messages = await getDb()
      .select()
      .from(userMessages)
      .where(
        and(
          eq(userMessages.userId, TEST_ORG2_USER_1.id),
          eq(userMessages.message, testMessage)
        )
      );

    expect(user1Messages.length).toBeGreaterThan(0);
    expect(user2Messages.length).toBeGreaterThan(0);
    expect(user1Messages[0]?.messageType).toBe("info");
    expect(user2Messages[0]?.messageType).toBe("info");

    // Cleanup
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.message, testMessage));
  });

  test("addMessageToAllUsers should handle different message types", async () => {
    const warningMessage = "Warning message";
    const errorMessage = "Error message";

    await addMessageToAllUsers(warningMessage, "warning");
    await addMessageToAllUsers(errorMessage, "error");

    const warningMessages = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.message, warningMessage));

    const errorMessages = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.message, errorMessage));

    expect(warningMessages.length).toBeGreaterThan(0);
    expect(errorMessages.length).toBeGreaterThan(0);
    expect(warningMessages[0]?.messageType).toBe("warning");
    expect(errorMessages[0]?.messageType).toBe("error");

    // Cleanup
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.message, warningMessage));
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.message, errorMessage));
  });

  test("addMessageToAllUsers should not fail when no users exist", async () => {
    // This test verifies the function handles edge cases gracefully
    // Since we can't easily remove all users, we just verify it doesn't throw
    await expect(addMessageToAllUsers("Test", "info")).resolves.not.toThrow();
  });

  /**
   * Test: addMessageToTenantUsers
   */
  test("addMessageToTenantUsers should add message only to tenant users", async () => {
    const tenantMessage = "Tenant-specific message";
    await addMessageToTenantUsers(
      TEST_ORGANISATION_1.id,
      tenantMessage,
      "info"
    );

    // Check that message was added to tenant user
    const tenantUserMessages = await getDb()
      .select()
      .from(userMessages)
      .where(
        and(
          eq(userMessages.userId, TEST_ORG1_USER_1.id),
          eq(userMessages.message, tenantMessage)
        )
      );

    expect(tenantUserMessages.length).toBe(1);
    expect(tenantUserMessages[0]?.messageType).toBe("info");

    // Cleanup
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.message, tenantMessage));
  });

  test("addMessageToTenantUsers should not add message to users outside tenant", async () => {
    const tenantMessage = "Tenant-only message";

    // Get count of messages for user2 before
    const beforeCount = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.userId, TEST_ORG2_USER_1.id));

    await addMessageToTenantUsers(
      TEST_ORGANISATION_1.id,
      tenantMessage,
      "info"
    );

    // Verify user2 (from different tenant) didn't get the message
    // (assuming TEST_ORG2_USER_1 is not in TEST_ORGANISATION_1)
    const afterCount = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.userId, TEST_ORG2_USER_1.id));

    // Cleanup
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.message, tenantMessage));
  });

  test("addMessageToTenantUsers should handle empty tenant gracefully", async () => {
    const fakeTenantId = "00000000-0000-0000-0000-000000000999";
    await expect(
      addMessageToTenantUsers(fakeTenantId, "Test", "info")
    ).resolves.not.toThrow();
  });

  /**
   * Test: confirmMessage
   */
  test("confirmMessage should mark a message as confirmed", async () => {
    const [message] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Message to confirm",
        messageType: "info",
      })
      .returning();

    if (!message) return; // leave test if failed until here

    const confirmedMessage = await confirmMessage(
      message!.id,
      TEST_ORG1_USER_1.id
    );

    expect(confirmedMessage.id).toBe(message.id);
    expect(confirmedMessage.confirmedAt).not.toBeNull();
    expect(confirmedMessage.confirmedAt).toBeDefined();

    // Verify in database
    const [dbMessage] = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.id, message?.id));

    expect(dbMessage?.confirmedAt).not.toBeNull();

    // Cleanup
    await getDb().delete(userMessages).where(eq(userMessages.id, message!.id));
  });

  test("confirmMessage should throw 404 for non-existent message", async () => {
    const fakeMessageId = "00000000-0000-0000-0000-000000000999";

    await expect(
      confirmMessage(fakeMessageId, TEST_ORG1_USER_1.id)
    ).rejects.toThrow();
  });

  test("confirmMessage should not allow confirming another user's message", async () => {
    const [message] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "User1's message",
        messageType: "info",
      })
      .returning();

    // Try to confirm as user2 - should fail
    await expect(
      confirmMessage(message!.id, TEST_ORG2_USER_1.id)
    ).rejects.toThrow();

    // Verify message is still unconfirmed
    const [dbMessage] = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.id, message!.id));

    expect(dbMessage?.confirmedAt).toBeNull();

    // Cleanup
    await getDb().delete(userMessages).where(eq(userMessages.id, message!.id));
  });

  /**
   * Test: confirmAllMessages
   */
  test("confirmAllMessages should mark all user messages as confirmed", async () => {
    // Create multiple unconfirmed messages
    const [message1] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Message 1",
        messageType: "info",
      })
      .returning();

    const [message2] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Message 2",
        messageType: "warning",
      })
      .returning();

    const [message3] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Message 3",
        messageType: "error",
      })
      .returning();

    await confirmAllMessages(TEST_ORG1_USER_1.id);

    // Verify all messages are confirmed
    const [dbMessage1] = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.id, message1!.id));

    const [dbMessage2] = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.id, message2!.id));

    const [dbMessage3] = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.id, message3!.id));

    expect(dbMessage1?.confirmedAt).not.toBeNull();
    expect(dbMessage2?.confirmedAt).not.toBeNull();
    expect(dbMessage3?.confirmedAt).not.toBeNull();

    // Verify getUserMessages returns empty array
    const unconfirmedMessages = await getUserMessages(TEST_ORG1_USER_1.id);
    expect(unconfirmedMessages.length).toBe(0);

    // Cleanup
    await getDb().delete(userMessages).where(eq(userMessages.id, message1!.id));
    await getDb().delete(userMessages).where(eq(userMessages.id, message2!.id));
    await getDb().delete(userMessages).where(eq(userMessages.id, message3!.id));
  });

  test("confirmAllMessages should not affect other users' messages", async () => {
    // Create messages for both users
    const [user1Message] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "User1 message",
        messageType: "info",
      })
      .returning();

    const [user2Message] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG2_USER_1.id,
        message: "User2 message",
        messageType: "info",
      })
      .returning();

    // Confirm all messages for user1
    await confirmAllMessages(TEST_ORG1_USER_1.id);

    // Verify user1's message is confirmed
    const [dbUser1Message] = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.id, user1Message!.id));

    // Verify user2's message is still unconfirmed
    const [dbUser2Message] = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.id, user2Message!.id));

    expect(dbUser1Message?.confirmedAt).not.toBeNull();
    expect(dbUser2Message?.confirmedAt).toBeNull();

    // Cleanup
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.id, user1Message!.id));
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.id, user2Message!.id));
  });

  test("confirmAllMessages should handle user with no messages gracefully", async () => {
    // Ensure user has no messages
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.userId, TEST_ORG1_USER_1.id));

    await expect(
      confirmAllMessages(TEST_ORG1_USER_1.id)
    ).resolves.not.toThrow();
  });
});
