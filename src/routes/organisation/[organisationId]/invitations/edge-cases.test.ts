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
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../../../../lib/db/db-connection";
import { organisationInvitations } from "../../../../lib/db/schema/users";
import { eq, and } from "drizzle-orm";

describe("Invitations Edge Cases and Error Handling", () => {
  const app: FastAppHono = new Hono();
  let u1Token: string;
  let u3Token: string;

  beforeAll(async () => {
    await createDatabaseClient();
    await waitForDbConnection();
    ({ user1Token: u1Token, user3Token: u3Token } = await initTests());

    defineInvitationsRoutes(app, "/api");

    // Clean up any existing test invitations
    await getDb()
      .delete(organisationInvitations)
      .where(
        and(
          eq(organisationInvitations.organisationId, TEST_ORGANISATION_1.id),
          eq(organisationInvitations.email, TEST_ORG3_USER_1.email)
        )
      );
  });

  // Test duplicate invitation handling
  test("should handle duplicate invitations", async () => {
    const invitationData = {
      organisationId: TEST_ORGANISATION_1.id,
      email: TEST_ORG3_USER_1.email,
      role: "member",
      status: "pending",
    };

    // Create first invitation
    console.log("creating first invitation");
    const response1 = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      u1Token,
      invitationData
    );
    expect(response1.status).toBe(200);

    // Create duplicate invitation
    console.log("creating duplicate invitation");
    const response2 = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      u1Token,
      invitationData
    );

    // Should still succeed (onConflictDoUpdate)
    expect(response2.status).toBe(200);
  }, 15000);

  // Test accepting an already accepted invitation
  test("should handle accepting an already accepted invitation", async () => {
    // Create a new invitation
    const invitationData = {
      organisationId: TEST_ORGANISATION_1.id,
      email: TEST_ORG3_USER_1.email,
      role: "member",
      status: "pending",
    };

    const createResponse = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      u1Token,
      invitationData
    );

    const invitationId = createResponse.jsonResponse.id;

    // Accept the invitation
    const acceptResponse1 = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${invitationId}/accept`,
      u3Token,
      {}
    );
    expect(acceptResponse1.status).toBe(200);

    // Try to accept it again
    const acceptResponse2 = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${invitationId}/accept`,
      u3Token,
      {}
    );

    // Should fail because invitation is no longer pending
    expect(acceptResponse2.status).toBe(500);
  }, 15000);

  // Test declining an already declined invitation
  test("should handle declining an already declined invitation", async () => {
    // Create a new invitation
    const invitationData = {
      organisationId: TEST_ORGANISATION_1.id,
      email: TEST_ORG3_USER_1.email,
      role: "member",
      status: "pending",
    };

    const createResponse = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      u1Token,
      invitationData
    );

    const invitationId = createResponse.jsonResponse.id;

    // Decline the invitation
    const declineResponse1 = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${invitationId}/decline`,
      u3Token,
      {}
    );
    expect(declineResponse1.status).toBe(200);

    // Try to decline it again (should work since we just update status)
    const declineResponse2 = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${invitationId}/decline`,
      u3Token,
      {}
    );

    expect(declineResponse2.status).toBe(200);
  }, 15000);

  // Test accepting a non-existent invitation
  test("should handle accepting a non-existent invitation", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000999";

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${nonExistentId}/accept`,
      u3Token,
      {}
    );

    expect(response.status).toBe(500);
  }, 15000);

  // Test declining a non-existent invitation
  test("should handle declining a non-existent invitation", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000999";

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${nonExistentId}/decline`,
      u3Token,
      {}
    );

    // This should still work since we just update by ID
    expect(response.status).toBe(200);
  }, 15000);

  // Test dropping a non-existent invitation
  test("should handle dropping a non-existent invitation", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000999";

    const response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${nonExistentId}`,
      u1Token
    );

    // This should still work since we just delete by ID
    expect(response.status).toBe(200);
  }, 15000);

  // Test accepting all invitations when there are none
  test("should handle accepting all invitations when there are none", async () => {
    // Clean up any existing invitations first
    await getDb()
      .delete(organisationInvitations)
      .where(
        and(
          eq(organisationInvitations.organisationId, TEST_ORGANISATION_1.id),
          eq(organisationInvitations.email, TEST_ORG3_USER_1.email)
        )
      );

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/all/accept`,
      u3Token,
      {}
    );

    expect(response.status).toBe(500); // Should fail with "No pending invitations found"
  }, 15000);

  // Test declining all invitations when there are none
  test("should handle declining all invitations when there are none", async () => {
    // Clean up any existing invitations first
    await getDb()
      .delete(organisationInvitations)
      .where(
        and(
          eq(organisationInvitations.organisationId, TEST_ORGANISATION_1.id),
          eq(organisationInvitations.email, TEST_ORG3_USER_1.email)
        )
      );

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/all/decline`,
      u3Token,
      {}
    );

    // This should still work since we just update by email
    expect(response.status).toBe(200);
  }, 15000);
});
