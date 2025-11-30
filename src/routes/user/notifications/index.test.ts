/**
 * Notifications API Routes Tests
 * Tests for user notification API endpoints
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { testFetcher } from "../../../test/fetcher.test";
import defineNotificationRoutes from ".";
import {
  initTests,
  TEST_ORG1_USER_1,
  TEST_ORG2_USER_1,
} from "../../../test/init.test";
import { Hono } from "hono";
import type { FastAppHonoContextVariables } from "../../../types";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../../../lib/db/db-connection";
import { getDb } from "../../../lib/db/db-connection";
import { userMessages } from "../../../lib/db/db-schema";
import { eq } from "drizzle-orm";

let app = new Hono<{ Variables: FastAppHonoContextVariables }>();
let TEST_USER_1_TOKEN: string;
let TEST_USER_2_TOKEN: string;

beforeAll(async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  defineNotificationRoutes(app, "/api/v1");
  const { user1Token, user2Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
  TEST_USER_2_TOKEN = user2Token;

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

describe("Notifications API Endpoints", () => {
  /**
   * GET /api/v1/user/notifications
   */
  test("GET /user/notifications should return empty array when no messages", async () => {
    const response = await testFetcher.get(
      app,
      "/api/v1/user/notifications",
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.jsonResponse)).toBe(true);
    expect(response.jsonResponse.length).toBe(0);
  });

  test("GET /user/notifications should return only unconfirmed messages", async () => {
    // Create confirmed and unconfirmed messages
    const [unconfirmedMessage] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Unconfirmed API test message",
        messageType: "info",
      })
      .returning();

    await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Confirmed API test message",
        messageType: "info",
        confirmedAt: new Date().toISOString(),
      })
      .returning();

    const response = await testFetcher.get(
      app,
      "/api/v1/user/notifications",
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.length).toBe(1);
    expect(response.jsonResponse[0].id).toBe(unconfirmedMessage?.id);
    expect(response.jsonResponse[0].confirmedAt).toBeNull();

    // Cleanup
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.userId, TEST_ORG1_USER_1.id));
  });

  test("GET /user/notifications should require authentication", async () => {
    const response = await testFetcher.get(
      app,
      "/api/v1/user/notifications",
      undefined
    );

    expect(response.status).toBe(401);
  });

  test("GET /user/notifications should return messages ordered by createdAt desc", async () => {
    const now = new Date();
    const [message1] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "First message",
        messageType: "info",
        createdAt: new Date(now.getTime() - 2000).toISOString(),
      })
      .returning();

    const [message2] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Second message",
        messageType: "warning",
        createdAt: new Date(now.getTime() - 1000).toISOString(),
      })
      .returning();

    const [message3] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Third message",
        messageType: "error",
        createdAt: now.toISOString(),
      })
      .returning();

    const response = await testFetcher.get(
      app,
      "/api/v1/user/notifications",
      TEST_USER_1_TOKEN
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.length).toBe(3);
    expect(response.jsonResponse[0].id).toBe(message3?.id);
    expect(response.jsonResponse[1].id).toBe(message2?.id);
    expect(response.jsonResponse[2].id).toBe(message1?.id);

    // Cleanup
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.userId, TEST_ORG1_USER_1.id));
  });

  /**
   * PATCH /api/v1/user/notifications/:messageId/confirm
   */
  test("PATCH /user/notifications/:messageId/confirm should mark message as confirmed", async () => {
    const [message] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "Message to confirm via API",
        messageType: "info",
      })
      .returning();

    const response = await testFetcher.patch(
      app,
      `/api/v1/user/notifications/${message?.id}/confirm`,
      TEST_USER_1_TOKEN,
      {}
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.id).toBe(message?.id);
    expect(response.jsonResponse.confirmedAt).not.toBeNull();

    // Verify message is no longer in unconfirmed list
    const getResponse = await testFetcher.get(
      app,
      "/api/v1/user/notifications",
      TEST_USER_1_TOKEN
    );
    expect(
      getResponse.jsonResponse.find((m: any) => m.id === message?.id)
    ).toBeUndefined();

    // Cleanup
    await getDb().delete(userMessages).where(eq(userMessages.id, message!.id));
  });

  test("PATCH /user/notifications/:messageId/confirm should return 404 for non-existent message", async () => {
    const fakeMessageId = "00000000-0000-0000-0000-000000000999";

    const response = await testFetcher.patch(
      app,
      `/api/v1/user/notifications/${fakeMessageId}/confirm`,
      TEST_USER_1_TOKEN,
      {}
    );

    expect(response.status).toBe(404);
  });

  test("PATCH /user/notifications/:messageId/confirm should not allow confirming another user's message", async () => {
    const [message] = await getDb()
      .insert(userMessages)
      .values({
        userId: TEST_ORG1_USER_1.id,
        message: "User1's message",
        messageType: "info",
      })
      .returning();

    // Try to confirm as user2
    const response = await testFetcher.patch(
      app,
      `/api/v1/user/notifications/${message?.id}/confirm`,
      TEST_USER_2_TOKEN,
      {}
    );

    expect(response.status).toBe(404);

    // Verify message is still unconfirmed
    const [dbMessage] = await getDb()
      .select()
      .from(userMessages)
      .where(eq(userMessages.id, message!.id));

    expect(dbMessage?.confirmedAt).toBeNull();

    // Cleanup
    await getDb().delete(userMessages).where(eq(userMessages.id, message!.id));
  });

  test("PATCH /user/notifications/:messageId/confirm should require authentication", async () => {
    const fakeMessageId = "00000000-0000-0000-0000-000000000999";

    const response = await testFetcher.patch(
      app,
      `/api/v1/user/notifications/${fakeMessageId}/confirm`,
      undefined,
      {}
    );

    expect(response.status).toBe(401);
  });

  /**
   * PATCH /api/v1/user/notifications/confirm-all
   */
  test("PATCH /user/notifications/confirm-all should mark all messages as confirmed", async () => {
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

    const response = await testFetcher.patch(
      app,
      "/api/v1/user/notifications/confirm-all",
      TEST_USER_1_TOKEN,
      {}
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.message).toBe(
      "All messages confirmed successfully"
    );

    // Verify all messages are confirmed
    const getResponse = await testFetcher.get(
      app,
      "/api/v1/user/notifications",
      TEST_USER_1_TOKEN
    );
    expect(getResponse.jsonResponse.length).toBe(0);

    // Cleanup
    await getDb().delete(userMessages).where(eq(userMessages.id, message1!.id));
    await getDb().delete(userMessages).where(eq(userMessages.id, message2!.id));
    await getDb().delete(userMessages).where(eq(userMessages.id, message3!.id));
  });

  test("PATCH /user/notifications/confirm-all should not affect other users' messages", async () => {
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
    await testFetcher.patch(
      app,
      "/api/v1/user/notifications/confirm-all",
      TEST_USER_1_TOKEN,
      {}
    );

    // Verify user1 has no unconfirmed messages
    const user1Response = await testFetcher.get(
      app,
      "/api/v1/user/notifications",
      TEST_USER_1_TOKEN
    );
    expect(user1Response.jsonResponse.length).toBe(0);

    // Verify user2 still has unconfirmed message
    const user2Response = await testFetcher.get(
      app,
      "/api/v1/user/notifications",
      TEST_USER_2_TOKEN
    );
    expect(user2Response.jsonResponse.length).toBe(1);
    expect(user2Response.jsonResponse[0].id).toBe(user2Message?.id);

    // Cleanup
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.id, user1Message!.id));
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.id, user2Message!.id));
  });

  test("PATCH /user/notifications/confirm-all should handle user with no messages gracefully", async () => {
    // Ensure user has no messages
    await getDb()
      .delete(userMessages)
      .where(eq(userMessages.userId, TEST_ORG1_USER_1.id));

    const response = await testFetcher.patch(
      app,
      "/api/v1/user/notifications/confirm-all",
      TEST_USER_1_TOKEN,
      {}
    );

    expect(response.status).toBe(200);
    expect(response.jsonResponse.message).toBe(
      "All messages confirmed successfully"
    );
  });

  test("PATCH /user/notifications/confirm-all should require authentication", async () => {
    const response = await testFetcher.patch(
      app,
      "/api/v1/user/notifications/confirm-all",
      undefined,
      {}
    );

    expect(response.status).toBe(401);
  });
});
