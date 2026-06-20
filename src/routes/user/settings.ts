/**
 * User settings routes
 * Authenticated users can manage their own key-value settings (e.g., theme preference)
 */

import type { SymbiosikaFrameworkHonoApp } from "../../types";
import { HTTPException } from "hono/http-exception";
import { authAndSetUsersInfo } from "../../lib/utils/hono-middlewares";
import { getDb } from "../../lib/db/db-connection";
import { userSettings } from "../../lib/db/db-schema";
import { eq, and } from "drizzle-orm";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { RESPONSES } from "../../lib/responses";

export function defineUserSettingsRoutes(
  app: SymbiosikaFrameworkHonoApp,
  API_BASE_PATH: string = ""
) {
  const baseRoute = `${API_BASE_PATH}/user/settings`;

  /**
   * GET /user/settings/:key
   * Get a specific setting for the authenticated user
   */
  app.get(
    `${baseRoute}/:key`,
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user-settings"],
      summary: "Get a user setting",
      responses: {
        200: {
          description: "Setting value",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  key: v.string(),
                  value: v.optional(v.string()),
                  valueJson: v.optional(v.unknown()),
                })
              ),
            },
          },
        },
        404: {
          description: "Setting not found",
        },
      },
    }),
    validator("param", v.object({ key: v.string() })),
    async (c) => {
      const userId = c.get("usersId");
      const { key } = c.req.valid("param");

      const db = await getDb();
      const setting = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.key, key))
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
   * POST /user/settings/:key
   * Set or update a user setting
   * Accepts either 'value' (string) or 'valueJson' (object)
   */
  app.post(
    `${baseRoute}/:key`,
    authAndSetUsersInfo,
    describeRoute({
      tags: ["user-settings"],
      summary: "Set a user setting",
      responses: {
        200: {
          description: "Setting updated",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  key: v.string(),
                  value: v.optional(v.string()),
                  valueJson: v.optional(v.unknown()),
                })
              ),
            },
          },
        },
      },
    }),
    validator("param", v.object({ key: v.string() })),
    validator(
      "json",
      v.object({
        value: v.optional(v.string()),
        valueJson: v.optional(v.unknown()),
        description: v.optional(v.string()),
      })
    ),
    async (c) => {
      const userId = c.get("usersId");
      const { key } = c.req.valid("param");
      const { value, valueJson, description } = c.req.valid("json");

      // Validate that at least one value is provided
      if (!value && !valueJson) {
        throw new HTTPException(400, {
          message: "Either 'value' or 'valueJson' must be provided",
        });
      }

      const db = await getDb();

      // Check if setting exists
      const existing = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.key, key))
        .limit(1)
        .then((rows) => rows[0]);

      if (existing) {
        // Update existing
        await db
          .update(userSettings)
          .set({
            value: value ?? existing.value,
            valueJson: valueJson ?? existing.valueJson,
            description: description ?? existing.description,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(userSettings.key, key));
      } else {
        // Create new
        await db.insert(userSettings).values({
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
}
