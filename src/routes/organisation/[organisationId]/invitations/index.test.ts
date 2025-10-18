import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import defineInvitationsRoutes from ".";
import type { FastAppHono } from "../../../../types";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORGANISATION_2,
  TEST_ORG2_USER_1,
  TEST_ORG3_USER_1,
} from "../../../../test/init.test";
import { testFetcher } from "../../../../test/fetcher.test";

describe("Invitations API Endpoints", () => {
  const app: FastAppHono = new Hono();
  let u1Token: string;
  let u2Token: string;
  let u3Token: string;
  let createdInvitationId: string;

  beforeAll(async () => {
    ({
      user1Token: u1Token,
      user2Token: u2Token,
      user3Token: u3Token,
    } = await initTests());

    defineInvitationsRoutes(app, "/api");
  });

  // Test creating an invitation
  test("should create a new invitation", async () => {
    const invitationData = {
      organisationId: TEST_ORGANISATION_1.id,
      email: TEST_ORG3_USER_1.email,
      role: "member",
      status: "pending",
    };

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      u1Token,
      invitationData
    );
    expect(response.status).toBe(200);
    expect(response.jsonResponse).toBeDefined();
    expect(response.jsonResponse.email).toBe(TEST_ORG3_USER_1.email);
    expect(response.jsonResponse.organisationId).toBe(TEST_ORGANISATION_1.id);
    expect(response.jsonResponse.status).toBe("pending");

    // Save the invitation ID for later tests
    createdInvitationId = response.jsonResponse.id;
  });

  // Test creating an invitation with mismatched organisationId
  test("should reject invitation with mismatched organisationId", async () => {
    const invitationData = {
      organisationId: TEST_ORGANISATION_2.id, // Different from URL param
      email: TEST_ORG3_USER_1.email,
      role: "member",
      status: "pending",
    };

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      u1Token,
      invitationData
    );
    expect(response.status).toBe(403);
    expect(response.textResponse).toContain(
      "The organisationId in the body does not match the organisationId in the path"
    );
  }, 15000);

  // Test getting all invitations for an organisation
  test("should get all invitations for an organisation", async () => {
    const response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      u1Token
    );
    expect(response.status).toBe(200);
    expect(Array.isArray(response.jsonResponse)).toBe(true);
    expect(response.jsonResponse.length).toBe(1);
  }, 15000);

  // Test accepting an invitation
  test("should accept an invitation", async () => {
    // First, create a new invitation for user2 to accept
    const invitationData = {
      organisationId: TEST_ORGANISATION_1.id,
      email: TEST_ORG2_USER_1.email,
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

    // Now accept the invitation
    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${invitationId}/accept`,
      u2Token,
      {}
    );

    expect(response.status).toBe(200);
  }, 15000);

  // Test accepting all invitations
  test("should accept all pending invitations for a user", async () => {
    // First, create multiple invitations for user3
    const invitationData = {
      organisationId: TEST_ORGANISATION_1.id,
      email: TEST_ORG3_USER_1.email,
      role: "member",
      status: "pending",
    };

    await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      u1Token,
      invitationData
    );

    // Now accept all invitations
    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/all/accept`,
      u3Token,
      {}
    );

    expect(response.status).toBe(200);
  }, 15000);

  // Test declining an invitation
  test("should decline an invitation", async () => {
    // First, create a new invitation
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

    // Now decline the invitation
    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${invitationId}/decline`,
      u3Token,
      {}
    );

    expect(response.status).toBe(200);
  }, 15000);

  // Test declining all invitations
  test("should decline all pending invitations for a user", async () => {
    // First, create multiple invitations for user3
    const invitationData = {
      organisationId: TEST_ORGANISATION_1.id,
      email: TEST_ORG3_USER_1.email,
      role: "member",
      status: "pending",
    };

    await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations?sendMail=false`,
      u1Token,
      invitationData
    );

    // Now decline all invitations
    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/all/decline`,
      u3Token,
      {}
    );

    expect(response.status).toBe(200);
  }, 15000);

  // Test dropping an invitation
  test("should drop an invitation", async () => {
    // First, create a new invitation
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

    // Now drop the invitation
    const response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${invitationId}`,
      u1Token
    );

    expect(response.status).toBe(200);
  }, 15000);

  // Test error handling for non-existent invitation
  test("should handle errors for non-existent invitation", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000999";

    const response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/invitations/${nonExistentId}/accept`,
      u3Token,
      {}
    );

    expect(response.status).toBe(500);
  }, 15000);
});
