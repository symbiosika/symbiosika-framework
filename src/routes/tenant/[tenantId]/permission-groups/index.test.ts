import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import definePermissionGroupRoutes from ".";
import type { FastAppHono } from "../../../../types";
import { initTests, TEST_ORGANISATION_1 } from "../../../../test/init.test";
import { testFetcher } from "../../../../test/fetcher.test";
import { rejectUnauthorized } from "../../../../test/reject-unauthorized.test";
import { getDb } from "../../../../lib/db/db-connection";
import { pathPermissions } from "../../../../lib/db/db-schema";
import { eq } from "drizzle-orm";

describe("Permission Groups API Endpoints", () => {
  let createdPermissionGroup: any;
  let createdPathPermission: any;
  const app: FastAppHono = new Hono();
  let user1Token: string;

  beforeAll(async () => {
    await initTests();
    const { user1Token: u1Token } = await initTests();
    user1Token = u1Token;
    definePermissionGroupRoutes(app, "/api");

    await getDb()
      .delete(pathPermissions)
      .where(eq(pathPermissions.tenantId, TEST_ORGANISATION_1.id));
  });

  // Security checks
  test("should reject unauthorized requests", async () => {
    rejectUnauthorized(app, [
      ["GET", `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups`],
      ["POST", `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups`],
      [
        "GET",
        `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups/some-id`,
      ],
      [
        "PUT",
        `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups/some-id`,
      ],
      [
        "DELETE",
        `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups/some-id`,
      ],
      ["POST", `/api/tenant/${TEST_ORGANISATION_1.id}/path-permissions`],
      [
        "GET",
        `/api/tenant/${TEST_ORGANISATION_1.id}/path-permissions/some-id`,
      ],
      [
        "PUT",
        `/api/tenant/${TEST_ORGANISATION_1.id}/path-permissions/some-id`,
      ],
      [
        "DELETE",
        `/api/tenant/${TEST_ORGANISATION_1.id}/path-permissions/some-id`,
      ],
    ]);
  });

  // Test CRUD operations for permission groups
  test("should perform CRUD operations on permission groups", async () => {
    // Create a permission group
    console.log("creating permission group");
    const permissionGroup = {
      name: "Test Permission Group",
      tenantId: TEST_ORGANISATION_1.id,
      meta: { description: "A test permission group" },
    };

    const createResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups`,
      user1Token,
      permissionGroup
    );

    expect(createResponse.status).toBe(200);
    expect(createResponse.jsonResponse.name).toBe("Test Permission Group");
    expect(createResponse.jsonResponse.tenantId).toBe(
      TEST_ORGANISATION_1.id
    );
    createdPermissionGroup = createResponse.jsonResponse;

    // Get all permission groups
    console.log("getting all permission groups");
    const listResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups`,
      user1Token
    );

    expect(listResponse.status).toBe(200);
    expect(Array.isArray(listResponse.jsonResponse)).toBe(true);
    expect(
      listResponse.jsonResponse.some(
        (group: any) => group.id === createdPermissionGroup.id
      )
    ).toBe(true);

    // Get a single permission group
    console.log("getting single permission group");
    const getResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups/${createdPermissionGroup.id}`,
      user1Token
    );

    expect(getResponse.status).toBe(200);
    expect(getResponse.jsonResponse.id).toBe(createdPermissionGroup.id);
    expect(getResponse.jsonResponse.name).toBe("Test Permission Group");

    // Update a permission group
    console.log("updating permission group");
    const updatedPermissionGroup = {
      name: "Updated Permission Group",
      tenantId: TEST_ORGANISATION_1.id,
      meta: { description: "An updated test permission group" },
    };

    const updateResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups/${createdPermissionGroup.id}`,
      user1Token,
      updatedPermissionGroup
    );

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.jsonResponse.name).toBe("Updated Permission Group");
    expect(updateResponse.jsonResponse.meta.description).toBe(
      "An updated test permission group"
    );
    // Delete will be tested at the end to ensure proper cleanup
  });

  // Test CRUD operations for path permissions
  test("should perform CRUD operations on path permissions", async () => {
    // Create a path permission
    console.log("creating path permission");
    const pathPermission = {
      category: "test-category",
      name: "test-permission",
      description: "A test path permission",
      type: "regex",
      method: "GET",
      pathExpression: "^/api/test/.*$",
      tenantId: TEST_ORGANISATION_1.id,
    };
    const createResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/path-permissions`,
      user1Token,
      pathPermission
    );
    // console.log(createResponse.textResponse);
    expect(createResponse.status).toBe(200);
    expect(createResponse.jsonResponse.name).toBe("test-permission");
    expect(createResponse.jsonResponse.category).toBe("test-category");
    expect(createResponse.jsonResponse.method).toBe("GET");
    expect(createResponse.jsonResponse.pathExpression).toBe("^/api/test/.*$");
    createdPathPermission = createResponse.jsonResponse;
    // console.log("createdPathPermission", createdPathPermission);

    // Get a single path permission
    const getResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/path-permissions/${createdPathPermission.id}`,
      user1Token
    );
    expect(getResponse.status).toBe(200);
    expect(getResponse.jsonResponse.id).toBe(createdPathPermission.id);
    expect(getResponse.jsonResponse.name).toBe("test-permission");
    // Update a path permission
    const updatedPathPermission = {
      category: "test-category",
      name: "updated-permission",
      description: "An updated test path permission",
      type: "regex",
      method: "GET",
      pathExpression: "^/api/updated/.*$",
      tenantId: TEST_ORGANISATION_1.id,
    };
    const updateResponse = await testFetcher.put(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/path-permissions/${createdPathPermission.id}`,
      user1Token,
      updatedPathPermission
    );
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.jsonResponse.name).toBe("updated-permission");
    expect(updateResponse.jsonResponse.pathExpression).toBe(
      "^/api/updated/.*$"
    );
    expect(updateResponse.jsonResponse.description).toBe(
      "An updated test path permission"
    );
    // Delete will be tested at the end to ensure proper cleanup
  });

  // Test assigning and removing permissions to/from groups
  test("should assign and remove permissions to/from groups", async () => {
    // Assign permission to group
    console.log("assigning permission to group");
    const assignResponse = await testFetcher.post(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups/${createdPermissionGroup.id}/permissions/${createdPathPermission.id}`,
      user1Token,
      {}
    );

    expect(assignResponse.status).toBe(200);
    expect(assignResponse.jsonResponse.groupId).toBe(createdPermissionGroup.id);
    expect(assignResponse.jsonResponse.permissionId).toBe(
      createdPathPermission.id
    );

    // Remove permission from group
    console.log("removing permission from group");
    const removeResponse = await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups/${createdPermissionGroup.id}/permissions/${createdPathPermission.id}`,
      user1Token
    );

    expect(removeResponse.status).toBe(200);
    expect(removeResponse.jsonResponse.success).toBe(true);
  });

  // Clean up - delete the created resources
  test("should delete created resources", async () => {
    // Delete path permission
    console.log("deleting path permission");
    const deletePathPermissionResponse = await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/path-permissions/${createdPathPermission.id}`,
      user1Token
    );

    expect(deletePathPermissionResponse.status).toBe(200);
    expect(deletePathPermissionResponse.jsonResponse.success).toBe(true);

    // Verify deletion
    console.log("verifying deletion");
    const getPathPermissionResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/path-permissions/${createdPathPermission.id}`,
      user1Token
    );
    console.log("getPathPermissionResponse", getPathPermissionResponse);
    expect(getPathPermissionResponse.status).toBe(500);
    expect(getPathPermissionResponse.textResponse).toContain(
      "Path permission not found"
    );

    // Delete permission group
    console.log("deleting permission group");
    const deletePermissionGroupResponse = await testFetcher.delete(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups/${createdPermissionGroup.id}`,
      user1Token
    );

    expect(deletePermissionGroupResponse.status).toBe(200);
    expect(deletePermissionGroupResponse.jsonResponse.success).toBe(true);

    // Verify deletion
    console.log("verifying deletion");
    const getPermissionGroupResponse = await testFetcher.get(
      app,
      `/api/tenant/${TEST_ORGANISATION_1.id}/permission-groups/${createdPermissionGroup.id}`,
      user1Token
    );
    expect(getPermissionGroupResponse.status).toBe(500);
    expect(getPermissionGroupResponse.textResponse).toContain(
      "Permission group not found"
    );
  });
});
