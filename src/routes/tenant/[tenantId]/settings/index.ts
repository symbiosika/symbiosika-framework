/**
 * Tenant (organisation) settings routes
 *
 * Per-tenant key-value settings shared by every member of the tenant. Reading
 * is open to any tenant member; creating, updating and deleting is restricted
 * to tenant admins/owners.
 *
 * These are the tenant-level counterpart to the per-user `/user/settings`
 * routes and store organisation-wide preferences (e.g. branding colours).
 */

import type { SymbiosikaFrameworkHonoApp } from "../../../../types";
import { HTTPException } from "hono/http-exception";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../lib/utils/hono-middlewares";
import { getDb } from "../../../../lib/db/db-connection";
import { tenantSettings } from "../../../../lib/db/db-schema";
import { eq, and } from "drizzle-orm";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { RESPONSES } from "../../../../lib/responses";
import { isTenantAdmin, isTenantMember } from "../..";
import { validateScope } from "../../../../lib/utils/validate-scope";

const settingResponseSchema = v.object({
  key: v.string(),
  value: v.optional(v.string()),
  valueJson: v.optional(v.unknown()),
});

export default function defineTenantSettingsRoutes(
  app: SymbiosikaFrameworkHonoApp,
  API_BASE_PATH: string = ""
) {
  const baseRoute = `${API_BASE_PATH}/tenant/:tenantId/settings`;

  /**
   * GET /tenant/:tenantId/settings
   * List all settings for the tenant. Readable by any tenant member.
   */
  app.get(
    baseRoute,
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["tenant-settings"],
      summary: "List all settings for a tenant",
      responses: {
        200: {
          description: "List of settings",
          content: {
            "application/json": {
              schema: resolver(v.array(settingResponseSchema)),
            },
          },
        },
      },
    }),
    validateScope("tenant-settings:read"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      const { tenantId } = c.req.valid("param");

      const db = await getDb();
      const rows = await db
        .select()
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));

      return c.json(
        rows.map((setting) => ({
          key: setting.key,
          ...(setting.value !== null && { value: setting.value }),
          ...(setting.valueJson !== null && { valueJson: setting.valueJson }),
        }))
      );
    }
  );

  /**
   * GET /tenant/:tenantId/settings/:key
   * Get a specific setting for the tenant. Readable by any tenant member.
   */
  app.get(
    `${baseRoute}/:key`,
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["tenant-settings"],
      summary: "Get a tenant setting",
      responses: {
        200: {
          description: "Setting value",
          content: {
            "application/json": {
              schema: resolver(settingResponseSchema),
            },
          },
        },
        404: {
          description: "Setting not found",
        },
      },
    }),
    validateScope("tenant-settings:read"),
    validator("param", v.object({ tenantId: v.string(), key: v.string() })),
    isTenantMember,
    async (c) => {
      const { tenantId, key } = c.req.valid("param");

      const db = await getDb();
      const setting = await db
        .select()
        .from(tenantSettings)
        .where(
          and(
            eq(tenantSettings.tenantId, tenantId),
            eq(tenantSettings.key, key)
          )
        )
        .limit(1)
        .then((rows) => rows[0]);

      if (!setting) {
        throw new HTTPException(404, { message: "Setting not found" });
      }

      return c.json({
        key: setting.key,
        ...(setting.value !== null && { value: setting.value }),
        ...(setting.valueJson !== null && { valueJson: setting.valueJson }),
      });
    }
  );

  /**
   * POST /tenant/:tenantId/settings/:key
   * Set or update a tenant setting. Restricted to tenant admins/owners.
   * Accepts either 'value' (string) or 'valueJson' (object).
   */
  app.post(
    `${baseRoute}/:key`,
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["tenant-settings"],
      summary: "Set a tenant setting",
      responses: {
        200: {
          description: "Setting updated",
          content: {
            "application/json": {
              schema: resolver(settingResponseSchema),
            },
          },
        },
      },
    }),
    validateScope("tenant-settings:write"),
    validator("param", v.object({ tenantId: v.string(), key: v.string() })),
    validator(
      "json",
      v.object({
        value: v.optional(v.string()),
        valueJson: v.optional(v.unknown()),
        description: v.optional(v.string()),
      })
    ),
    isTenantAdmin,
    async (c) => {
      const { tenantId, key } = c.req.valid("param");
      const { value, description } = c.req.valid("json");
      const valueJson = c.req.valid("json").valueJson as
        | Record<string, unknown>
        | undefined;

      // Validate that at least one value is provided
      if (!value && !valueJson) {
        throw new HTTPException(400, {
          message: "Either 'value' or 'valueJson' must be provided",
        });
      }

      const db = await getDb();

      // Check if the setting already exists for this tenant
      const existing = await db
        .select()
        .from(tenantSettings)
        .where(
          and(
            eq(tenantSettings.tenantId, tenantId),
            eq(tenantSettings.key, key)
          )
        )
        .limit(1)
        .then((rows) => rows[0]);

      if (existing) {
        await db
          .update(tenantSettings)
          .set({
            value: value ?? existing.value,
            valueJson: valueJson ?? existing.valueJson,
            description: description ?? existing.description,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(tenantSettings.tenantId, tenantId),
              eq(tenantSettings.key, key)
            )
          );
      } else {
        await db.insert(tenantSettings).values({
          tenantId,
          key,
          value: value || null,
          valueJson: valueJson || null,
          description,
        });
      }

      return c.json(
        {
          key,
          ...(value && { value }),
          ...(valueJson && { valueJson }),
        },
        200
      );
    }
  );

  /**
   * DELETE /tenant/:tenantId/settings/:key
   * Delete a tenant setting. Restricted to tenant admins/owners.
   */
  app.delete(
    `${baseRoute}/:key`,
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["tenant-settings"],
      summary: "Delete a tenant setting",
      responses: {
        200: {
          description: "Setting deleted",
        },
      },
    }),
    validateScope("tenant-settings:write"),
    validator("param", v.object({ tenantId: v.string(), key: v.string() })),
    isTenantAdmin,
    async (c) => {
      const { tenantId, key } = c.req.valid("param");

      const db = await getDb();
      await db
        .delete(tenantSettings)
        .where(
          and(
            eq(tenantSettings.tenantId, tenantId),
            eq(tenantSettings.key, key)
          )
        );

      return c.json(RESPONSES.SUCCESS);
    }
  );
}
