/**
 * Routes to manage the files of an tenant
 * These routes are protected by JWT and CheckPermission middleware
 */
import { HTTPException } from "hono/http-exception";
import {
  deleteFileFromDB,
  saveFileToDb,
  getFileFromDb,
} from "../../../../lib/storage/db";
import {
  deleteFileFromLocalDisc,
  getFileFromLocalDisc,
  saveFileToLocalDisc,
} from "../../../../lib/storage/local";
import type { FastAppHono } from "../../../../types";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../lib/utils/hono-middlewares";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { files, filesSelectSchema } from "../../../../lib/db/db-schema";
import { getDb } from "../../../../lib/db/db-connection";
import { and, eq } from "drizzle-orm";
import {
  isTenantAdmin,
  isTenantMember,
} from "../../../tenant/index";
import { validateScope } from "../../../../lib/utils/validate-scope";

/**
 * Define the payment routes
 */
export function defineFilesRoutes(app: FastAppHono, API_BASE_PATH: string) {
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/files/:type/:bucket",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["files"],
      summary: "Save files",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  path: v.string(),
                  id: v.string(),
                  name: v.string(),
                  tenantId: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("files:write"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        type: v.union([v.literal("local"), v.literal("db")]),
        bucket: v.string(),
      })
    ),
    validator(
      "form",
      v.object({
        file: v.any(),
        chatId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
      })
    ),
    isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, type, bucket } = c.req.valid("param");
        const form = c.req.valid("form");

        const options = {
          ...(form.chatId && { chatId: form.chatId }),
          ...(form.workspaceId && { workspaceId: form.workspaceId }),
        };

        if (type === "db") {
          const entry = await saveFileToDb(
            form.file,
            bucket,
            tenantId,
            options
          );
          return c.json(entry);
        } else if (type === "local") {
          const entry = await saveFileToLocalDisc(
            form.file,
            bucket,
            tenantId,
            options
          );
          return c.json(entry);
        }
      } catch (err) {
        throw new HTTPException(400, { message: err + "" });
      }
    }
  );

  app.get(
    API_BASE_PATH +
      "/tenant/:tenantId/files/:type/:bucket/:filename",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["files"],
      summary: "Get a file",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("files:read"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        type: v.union([v.literal("local"), v.literal("db")]),
        bucket: v.string(),
        filename: v.string(),
      })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId, type, bucket, filename } = c.req.valid("param");

        // get the file
        let f: File;
        if (type === "db") {
          f = await getFileFromDb(filename, bucket, tenantId);
        } else if (type === "local") {
          f = await getFileFromLocalDisc(filename, bucket, tenantId);
        } else {
          throw new HTTPException(400, { message: "Invalid type" });
        }
        return new Response(f, {
          status: 200,
          headers: {
            "Content-Type": f.type,
          },
        });
      } catch (err) {
        throw new HTTPException(400, { message: err + "" });
      }
    }
  );

  app.get(
    API_BASE_PATH +
      "/tenant/:tenantId/files/:type/:bucket/:id/info",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["files"],
      summary: "Get a file info",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(filesSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("files:read"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        type: v.union([v.literal("local"), v.literal("db")]),
        bucket: v.string(),
        id: v.string(),
      })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId, type, bucket, id } = c.req.valid("param");

        if (type === "db") {
          const f = await getDb()
            .select({
              id: files.id,
              name: files.name,
              fileType: files.fileType,
              extension: files.extension,
              createdAt: files.createdAt,
              updatedAt: files.updatedAt,
              tenantId: files.tenantId,
              bucket: files.bucket,
              expiresAt: files.expiresAt,
            })
            .from(files)
            .where(
              and(
                eq(files.id, id),
                eq(files.bucket, bucket),
                eq(files.tenantId, tenantId)
              )
            );
          if (f.length === 0) {
            throw new HTTPException(404, { message: "File not found" });
          }
          return c.json(f[0]);
        } else {
          throw new HTTPException(400, { message: "Invalid type" });
        }
      } catch (err) {
        throw new HTTPException(400, { message: err + "" });
      }
    }
  );

  app.delete(
    API_BASE_PATH + "/tenant/:tenantId/files/:type/:bucket/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["files"],
      summary: "Delete a file",
      responses: {
        204: {
          description: "Successful response",
        },
      },
    }),
    validateScope("files:write"),
    validator(
      "param",
      v.object({
        tenantId: v.string(),
        type: v.union([v.literal("local"), v.literal("db")]),
        bucket: v.string(),
        id: v.string(),
      })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId, type, bucket, id } = c.req.valid("param");

        // delete the file
        if (type === "db") {
          await deleteFileFromDB(id, bucket, tenantId);
        } else if (type === "local") {
          await deleteFileFromLocalDisc(id, bucket, tenantId);
        }

        return new Response(null, { status: 204 });
      } catch (err) {
        throw new HTTPException(400, { message: err + "" });
      }
    }
  );
}
