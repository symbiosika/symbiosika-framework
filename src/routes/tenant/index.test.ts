import { describe, it, expect, beforeAll } from "bun:test";
import type { SymbiosikaFrameworkHonoApp } from "../../types";
import defineTenantRoutes from "./index";
import { addTenantMember } from "../../lib/usermanagement/tenants";
import { Hono } from "hono";
import {
  deleteTestOrganisations,
  initTests,
  TEST_USERS,
} from "../../test/init.test";
import { testFetcher } from "../../test/fetcher.test";
import { type TenantsSelect } from "../../lib/db/db-schema";

let app: SymbiosikaFrameworkHonoApp;
let TEST_USER_1_TOKEN: string;
let TEST_USER_2_TOKEN: string;
let TEST_USER_3_TOKEN: string;

beforeAll(async () => {
  const { user1Token, user2Token, user3Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
  TEST_USER_2_TOKEN = user2Token;
  TEST_USER_3_TOKEN = user3Token;
  app = new Hono();
  defineTenantRoutes(app, "/api");
});

let org: TenantsSelect;

describe("Organisation Routes", () => {
  it("should execute tests sequentially", async () => {
    console.log("Starting test: Create a new tenant");

    await deleteTestOrganisations();

    let response = await testFetcher.post(
      app,
      "/api/tenant",
      TEST_USER_3_TOKEN,
      {
        name: "User3 Organisation",
      }
    );
    expect(response.status).toBe(200);
    let data = response.jsonResponse;
    org = data;
    console.log("Added tenant:", org);
    expect(data.name).toBe("User3 Organisation");

    console.log(
      "Starting test: Attempt to create another tenant with the same name"
    );
    response = await testFetcher.post(app, "/api/tenant", TEST_USER_3_TOKEN, {
      name: "Another Organisation",
    });
    let errorText: string | null = response.textResponse;
    expect(errorText).toBe(
      "Error creating tenant: Error: User already has an tenant"
    );

    console.log("Starting test: Add a member to the tenant");
    response = await testFetcher.post(
      app,
      `/api/tenant/${org.id}/members`,
      TEST_USER_3_TOKEN,
      { userId: TEST_USERS[1]!.id, role: "member" }
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.userId).toBe(TEST_USERS[1]!.id);

    console.log("Starting test: Remove a member from the tenant");
    response = await testFetcher.delete(
      app,
      `/api/tenant/${org.id}/members/${TEST_USERS[1]!.id}`,
      TEST_USER_3_TOKEN
    );
    expect(response.status).toBe(200);

    console.log("Starting test: Get an tenant");
    response = await testFetcher.get(
      app,
      `/api/tenant/${org.id}`,
      TEST_USER_3_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.name).toBe("User3 Organisation");

    console.log("Starting test: Get all members of an tenant");
    await addTenantMember(org.id, TEST_USERS[1]!.id, "member");
    response = await testFetcher.get(
      app,
      `/api/tenant/${org.id}/members`,
      TEST_USER_3_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;

    expect.arrayContaining([
      { userEmail: TEST_USERS[1]!.email, role: "member" },
    ]);

    console.log("Starting test: Update an tenant");
    response = await testFetcher.put(
      app,
      `/api/tenant/${org.id}`,
      TEST_USER_3_TOKEN,
      { name: "New Name" }
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.name).toBe("New Name");

    console.log("Starting test: Invite a user to an tenant");
    response = await testFetcher.post(
      app,
      `/api/tenant/${org.id}/invite`,
      TEST_USER_3_TOKEN,
      { email: "invitee@example.com", role: "member", sendMail: false }
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.email).toBe("invitee@example.com");

    console.log("Starting test: Add a member directly to an tenant");
    response = await testFetcher.post(
      app,
      `/api/tenant/${org.id}/members`,
      TEST_USER_3_TOKEN,
      { userId: TEST_USERS[0]!.id, role: "member" }
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.userId).toBe(TEST_USERS[0]!.id);

    console.log("Starting test: Remove a member from an tenant");
    response = await testFetcher.delete(
      app,
      `/api/tenant/${org.id}/members/${TEST_USERS[0]!.id}`,
      TEST_USER_3_TOKEN
    );
    errorText = response.textResponse;
    expect(response.status).toBe(200);

    // Permission tests
    console.log("Starting test: Non-members should not get tenant details");
    response = await testFetcher.get(
      app,
      `/api/tenant/${org.id}`,
      TEST_USER_1_TOKEN
    );
    errorText = response.textResponse;
    expect(response.status).toBe(403);

    console.log("Starting test: Non-admins should not update an tenant");
    response = await testFetcher.put(
      app,
      `/api/tenant/${org.id}`,
      TEST_USER_2_TOKEN,
      { name: "New Name" }
    );
    errorText = response.textResponse;
    expect(response.status).toBe(403);

    console.log("Starting test: Non-admins should not delete an tenant");
    response = await testFetcher.delete(
      app,
      `/api/tenant/${org.id}`,
      TEST_USER_2_TOKEN
    );
    expect(response.status).toBe(403);

    console.log("Starting test: Non-admins should not invite users");
    response = await testFetcher.post(
      app,
      `/api/tenant/${org.id}/invite`,
      TEST_USER_2_TOKEN,
      { email: "invitee@example.com", role: "member" }
    );
    expect(response.status).toBe(403);

    console.log("Starting test: Non-admins should not add members directly");
    response = await testFetcher.post(
      app,
      `/api/tenant/${org.id}/members`,
      TEST_USER_2_TOKEN,
      { userId: TEST_USERS[2]!.id, role: "member" }
    );
    expect(response.status).toBe(403);

    console.log("Starting test: Non-admins should not remove members");
    response = await testFetcher.delete(
      app,
      `/api/tenant/${org.id}/members/${TEST_USERS[2]!.id}`,
      TEST_USER_2_TOKEN
    );
    expect(response.status).toBe(403);

    console.log("All tests completed successfully.");

    console.log("Starting test: Delete the tenant");
    response = await testFetcher.delete(
      app,
      `/api/tenant/${org.id}`,
      TEST_USER_3_TOKEN
    );
    expect(response.status).toBe(200);
  });
});
