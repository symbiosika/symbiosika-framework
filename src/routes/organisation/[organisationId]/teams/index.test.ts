import { describe, test, expect, beforeAll } from "bun:test";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG2_USER_1,
  TEST_ORG1_USER_1,
} from "../../../../test/init.test";
import defineTeamRoutes from "./index";
import { testFetcher } from "../../../../test/fetcher.test";
import { Hono } from "hono";
import { getDb } from "../../../../lib/db/db-connection";
import { teams } from "../../../../lib/db/db-schema";
import { eq } from "drizzle-orm";
import type { FastAppHono } from "../../../../types";
import { addOrganisationMember } from "../../../../lib/usermanagement/oganisations";

let app: FastAppHono;
let adminToken: string;
let memberToken: string;
let nonMemberToken: string;

beforeAll(async () => {
  await initTests();
  const { user1Token, user2Token, user3Token } = await initTests();
  adminToken = user1Token;
  memberToken = user2Token; // Assuming user 1 is a member
  nonMemberToken = user3Token; // Assuming user 2 is not a member

  app = new Hono();
  defineTeamRoutes(app, "/api");

  //
  // delete all teams in the test organisation
  //
  await getDb()
    .delete(teams)
    .where(eq(teams.organisationId, TEST_ORGANISATION_1.id));
});

describe("Teams API Endpoints", () => {
  test("Full CRUD and Permission Tests", async () => {
    // ------------------------------------------------------------
    // create a new team
    // ------------------------------------------------------------
    console.log("Step 1: Create a new team");
    const addedTeam = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams`,
      adminToken,
      {
        organisationId: TEST_ORGANISATION_1.id,
        name: "New Team",
        description: "A new team for testing",
        meta: {},
      }
    );
    // console.log(addedTeam.textResponse);
    expect(addedTeam.status).toBe(200);
    expect(addedTeam.jsonResponse?.name).toBe("New Team");

    const addedTeamId = addedTeam.jsonResponse.id;

    // ------------------------------------------------------------
    // get all teams of an organisation
    // ------------------------------------------------------------
    console.log("Step 2: Get all teams of an organisation");
    let response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams`,
      adminToken
    );
    // console.log(response.textResponse);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.jsonResponse)).toBe(true);

    // ------------------------------------------------------------
    // get a team by teamId
    // ------------------------------------------------------------
    console.log("Step 3: Get a team by teamId");
    response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}`,
      adminToken
    );
    // console.log(response.textResponse);
    expect(response.status).toBe(200);
    expect(response.jsonResponse?.id).toBe(addedTeamId);

    // ------------------------------------------------------------
    // update a team
    // ------------------------------------------------------------
    console.log("Step 4: Update a team");
    response = await testFetcher.put(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}`,
      adminToken,
      {
        name: "Updated Team Name",
        organisationId: TEST_ORGANISATION_1.id,
      }
    );
    // console.log(response.textResponse);
    expect(response.status).toBe(200);
    expect(response.jsonResponse?.name).toBe("Updated Team Name");

    // ------------------------------------------------------------
    // read all members of a team
    // ------------------------------------------------------------
    console.log("Step 5: Read all members of a team");
    response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}/members`,
      adminToken
    );
    // console.log(response.textResponse);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.jsonResponse)).toBe(true);
    expect(response.jsonResponse?.length).toBe(1);
    expect(response.jsonResponse?.[0].userId).toBe(TEST_ORG1_USER_1.id);

    // ------------------------------------------------------------
    // read all members of a team with a non-admin token
    // ------------------------------------------------------------
    console.log("Step 6: Read all members of a team with a non-admin token");
    response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}/members`,
      memberToken
    );
    // console.log(response.textResponse);
    expect(response.status).toBe(403);

    // ------------------------------------------------------------
    // add a member to a team. should fail because the user is not a member of the organisation
    // ------------------------------------------------------------
    console.log("Step 7: Add a member to a team");
    console.log(
      "Try to add a member to a team which is not a member of the organisation"
    );
    response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}/members`,
      adminToken,
      {
        userId: TEST_ORG2_USER_1.id,
        role: "member",
      }
    );
    // console.log(response.textResponse);
    expect(response.status).toBe(500);
    expect(response.textResponse).toContain(
      "User is not part of the organisation"
    );

    // ------------------------------------------------------------
    // add the member to the organisation
    // ------------------------------------------------------------
    await addOrganisationMember(
      TEST_ORGANISATION_1.id,
      TEST_ORG2_USER_1.id,
      "member"
    );

    // ------------------------------------------------------------
    // try again. now it should work
    // ------------------------------------------------------------
    console.log(
      "Try to add a member to a team which is now a member of the organisation"
    );
    response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}/members`,
      adminToken,
      {
        userId: TEST_ORG2_USER_1.id,
        role: "member",
      }
    );
    // console.log(response.textResponse);
    expect(response.status).toBe(200);
    expect(response.jsonResponse?.userId).toBe(TEST_ORG2_USER_1.id);

    // ------------------------------------------------------------
    // change the role of a member
    // ------------------------------------------------------------
    console.log("Step 8: Change the role of a member");
    response = await testFetcher.put(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}/members/${TEST_ORG2_USER_1.id}`,
      adminToken,
      {
        role: "admin",
      }
    );
    expect(response.status).toBe(200);
    expect(response.jsonResponse?.role).toBe("admin");

    // ------------------------------------------------------------
    // remove a member from a team
    // ------------------------------------------------------------
    console.log("Step 9: Remove a member from a team");
    response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}/members/${TEST_ORG2_USER_1.id}`,
      adminToken
    );
    expect(response.status).toBe(200);

    // ------------------------------------------------------------
    // permission check: non-member trying to access team
    // ------------------------------------------------------------
    console.log("Step 10: Permission check: Non-member trying to access team");
    response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}`,
      nonMemberToken
    );
    expect(response.status).toBe(403);

    // ------------------------------------------------------------
    // delete a team
    // ------------------------------------------------------------

    console.log("Step 11: Delete a team with a non-admin token");
    response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}`,
      memberToken // Non-admin token
    );
    expect(response.status).toBe(403);

    console.log("Step 11: Delete a team");
    response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams/${addedTeamId}`,
      adminToken
    );
    expect(response.status).toBe(200);
  });

  test("Unauthorized access to get all teams", async () => {
    const response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/teams`,
      undefined
    );
    expect(response.status).toBe(401);
  });
});
