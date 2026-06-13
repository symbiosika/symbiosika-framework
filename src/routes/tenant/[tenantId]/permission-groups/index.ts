/**
 * Routes to manage the permission groups of an tenant
 * These routes are protected by JWT and CheckPermission middleware
 * These routes are NOT used by the frontend in normal applications!
 */

import type { SymbiosikaFrameworkHonoApp } from "../../../../types";
import { HTTPException } from "hono/http-exception";
import { authAndSetUsersInfo } from "../../../../lib/utils/hono-middlewares";
import {
  createPermissionGroup,
  getPermissionGroup,
  updatePermissionGroup,
  deletePermissionGroup,
  getPermissionGroupsByOrganisation,
  createPathPermission,
  getPathPermission,
  updatePathPermission,
  assignPermissionToGroup,
  deletePathPermission,
  removePermissionFromGroup,
} from "../../../../lib/usermanagement/permissions";
import { resolver, validator } from "hono-openapi";
import {
  pathPermissionsInsertSchema,
  pathPermissionsSelectSchema,
  pathPermissionsUpdateSchema,
  userPermissionGroupsInsertSchema,
  userPermissionGroupsSelectSchema,
  userPermissionGroupsUpdateSchema,
} from "../../../../lib/db/db-schema";
import * as v from "valibot";
import { describeRoute } from "hono-openapi";
import { RESPONSES } from "../../../../lib/responses";
import { validateScope } from "../../../../lib/utils/validate-scope";
import { isTenantAdmin } from "../../../tenant/index";

export default function definePermissionGroupRoutes(
  app: SymbiosikaFrameworkHonoApp,
  API_BASE_PATH: string
) {
  /**
   * Create a new permission group
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/permission-groups",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Create a new permission group",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(userPermissionGroupsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("permissions:write"),
    validator("json", userPermissionGroupsInsertSchema),
    async (c) => {
      try {
        const data = c.req.valid("json");
        const group = await createPermissionGroup(data);
        return c.json(group);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error creating permission group: " + err,
        });
      }
    }
  );

  /**
   * Get all permission groups of an tenant
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/permission-groups",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Get all permission groups of an tenant",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(v.array(userPermissionGroupsSelectSchema)),
            },
          },
        },
      },
    }),
    validateScope("permissions:read"),
    validator("param", v.object({ tenantId: v.string() })),
    async (c) => {
      try {
        const { tenantId } = c.req.valid("param");
        const groups = await getPermissionGroupsByOrganisation(tenantId);
        return c.json(groups);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting permission groups: " + err,
        });
      }
    }
  );

  /**
   * Get a single permission group
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/permission-groups/:id",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Get a single permission group",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(userPermissionGroupsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("permissions:read"),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const group = await getPermissionGroup(id);
        return c.json(group);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting permission group: " + err,
        });
      }
    }
  );

  /**
   * Update a permission group
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/permission-groups/:id",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Update a permission group",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(userPermissionGroupsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("permissions:write"),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    validator("json", userPermissionGroupsUpdateSchema),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const data = c.req.valid("json");
        const group = await updatePermissionGroup(id, data);
        return c.json(group);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error updating permission group: " + err,
        });
      }
    }
  );

  /**
   * Delete a permission group
   */
  app.delete(
    API_BASE_PATH + "/tenant/:tenantId/permission-groups/:id",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Delete a permission group",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("permissions:write"),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deletePermissionGroup(id);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error deleting permission group: " + err,
        });
      }
    }
  );

  /**
   * Assign a permission to a permission group
   */
  app.post(
    API_BASE_PATH +
      "/tenant/:tenantId/permission-groups/:groupId/permissions/:permissionId",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Assign a permission to a permission group",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  groupId: v.string(),
                  permissionId: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("permissions:write"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        groupId: v.string(),
        permissionId: v.string(),
      })
    ),
    async (c) => {
      try {
        const { tenantId, groupId, permissionId } = c.req.valid("param");
        const result = await assignPermissionToGroup(groupId, permissionId);
        return c.json(result);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error assigning permission to group: " + err,
        });
      }
    }
  );

  /**
   * Remove a permission from a permission group
   */
  app.delete(
    API_BASE_PATH +
      "/tenant/:tenantId/permission-groups/:groupId/permissions/:permissionId",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Remove a permission from a permission group",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("permissions:write"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        groupId: v.string(),
        permissionId: v.string(),
      })
    ),
    async (c) => {
      try {
        const { tenantId, groupId, permissionId } = c.req.valid("param");
        await removePermissionFromGroup(groupId, permissionId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error removing permission from group: " + err,
        });
      }
    }
  );

  /**
   * Create a new path permission
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/path-permissions",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Create a new path permission",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(pathPermissionsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("permissions:write"),
    validator("json", pathPermissionsInsertSchema),
    async (c) => {
      try {
        const data = c.req.valid("json");
        const permission = await createPathPermission(data);
        return c.json(permission);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error creating path permission: " + err,
        });
      }
    }
  );

  /**
   * Get a single path permission
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/path-permissions/:id",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Get a single path permission",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(pathPermissionsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("permissions:read"),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const permission = await getPathPermission(id);
        return c.json(permission);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting path permission: " + err,
        });
      }
    }
  );

  /**
   * Update a path permission
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/path-permissions/:id",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Update a path permission",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(pathPermissionsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("permissions:write"),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    validator("json", pathPermissionsUpdateSchema),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const data = c.req.valid("json");
        const permission = await updatePathPermission(id, data);
        return c.json(permission);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error updating path permission: " + err,
        });
      }
    }
  );

  /**
   * Delete a path permission
   */
  app.delete(
    API_BASE_PATH + "/tenant/:tenantId/path-permissions/:id",
    authAndSetUsersInfo,
    isTenantAdmin,
    describeRoute({
      tags: ["permission-groups"],
      summary: "Delete a path permission",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("permissions:write"),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        await deletePathPermission(id);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error deleting path permission: " + err,
        });
      }
    }
  );
}
