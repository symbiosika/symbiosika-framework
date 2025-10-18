import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import defineInvitationsRoutes from ".";
import type { FastAppHono } from "../../../../types";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG3_USER_1,
} from "../../../../test/init.test";
import { testFetcher } from "../../../../test/fetcher.test";
import { rejectUnauthorized } from "../../../../test/reject-unauthorized.test";
import { getDb } from "../../../../lib/db/db-connection";
import { organisationInvitations } from "../../../../lib/db/schema/users";
import { eq } from "drizzle-orm";

const app: FastAppHono = new Hono();
defineInvitationsRoutes(app, "/api");

describe("Invitations Security Tests", () => {
  let user1Token: string;
  let user2Token: string;
  let createdInvitationId: string;

  beforeAll(async () => {
    await initTests();
    const { user1Token: u1Token, user2Token: u2Token } = await initTests();
    user1Token = u1Token;
    user2Token = u2Token;

    // Create a test invitation for security tests
    const invitationData = {
      organisationId: TEST_ORGANISATION_1.id,
      email: TEST_ORG3_USER_1.email,
      role: "member",
      status: "pending",
    };

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      user1Token,
      invitationData
    );

    createdInvitationId = response.jsonResponse.id;
  });

  test("should reject unauthorized requests", async () => {
    rejectUnauthorized(app, [
      ["GET", `/api/organisation/${TEST_ORGANISATION_1.id}/invitations`],
      ["POST", `/api/organisation/${TEST_ORGANISATION_1.id}/invitations`],
      [
        "DELETE",
        `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${createdInvitationId}`,
      ],
      [
        "POST",
        `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${createdInvitationId}/accept`,
      ],
      [
        "POST",
        `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${createdInvitationId}/decline`,
      ],
    ]);
  });

  test("should reject access to invitations from other organisations", async () => {
    // User2 tries to access invitations from Organisation1
    const response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations`,
      user2Token
    );

    expect(response.status).toBe(403);
  });

  test("should reject invitation creation for other organisations", async () => {
    // User2 tries to create an invitation for Organisation1
    const invitationData = {
      organisationId: TEST_ORGANISATION_1.id,
      email: "test@example.com",
      role: "member",
      status: "pending",
    };

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      user2Token,
      invitationData
    );

    expect(response.status).toBe(403);
  });

  test("should reject invitation deletion from other organisations", async () => {
    // User2 tries to delete an invitation from Organisation1
    const response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${createdInvitationId}`,
      user2Token
    );

    expect(response.status).toBe(403);
  });

  test("should validate invitation data on creation", async () => {
    // Try to create an invitation with invalid data
    const invalidData = {
      organisationId: TEST_ORGANISATION_1.id,
      // Missing required email field
      role: "member",
      status: "pending",
    };

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      user1Token,
      invalidData
    );

    expect(response.status).toBe(400); // Validation error
  });
});
