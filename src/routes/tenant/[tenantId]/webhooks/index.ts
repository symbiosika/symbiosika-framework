import type { SymbiosikaFrameworkHonoApp } from "../../../../types";
import { HTTPException } from "hono/http-exception";
import { authAndSetUsersInfo } from "../../../../lib/utils/hono-middlewares";
import {
  createWebhook,
  deleteWebhook,
  getAllOrganisationWebhooks,
  getAllUsersWebhooks,
  getWebhookById,
  updateWebhook,
} from "../../../../lib/webhooks/crud";
import {
  newWebhookSchema,
  updateWebhookSchema,
  webhookSchema,
} from "../../../../lib/db/schema/webhooks";
import * as v from "valibot";
import {
  triggerWebhook,
  WebhookTriggerError,
} from "../../../../lib/webhooks/trigger";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import { RESPONSES } from "../../../../lib/responses";
import { validateScope } from "../../../../lib/utils/validate-scope";
import { isTenantAdmin, isTenantMember } from "../../../tenant/index";
import log from "../../../../lib/log";

/**
 * Helper to replace all whitespace in a string with underscores
 * and lowercase the string
 */
const normalizeToolName = (name: string): string => {
  return name.replace(/\s+/g, "_").toLowerCase();
};

export default function defineWebhookRoutes(
  app: SymbiosikaFrameworkHonoApp,
  API_BASE_PATH: string
) {
  /**
   * Create a new webhook
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/webhooks",
    authAndSetUsersInfo,
    isTenantMember,
    describeRoute({
      tags: ["webhooks"],
      summary: "Create a new webhook",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(webhookSchema),
            },
          },
        },
      },
    }),
    validateScope("webhooks:write"),
    validator("json", newWebhookSchema),
    validator("param", v.object({ tenantId: v.string() })),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const parsed = c.req.valid("json");
        const { tenantId } = c.req.valid("param");

        const webhook = await createWebhook(userId, {
          ...parsed,
          tenantId,
          userId,
        });

        return c.json(webhook);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error creating webhook: " + err,
        });
      }
    }
  );

  /**
   * Get all webhooks for the user
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/webhooks",
    authAndSetUsersInfo,
    isTenantMember,
    describeRoute({
      tags: ["webhooks"],
      summary: "Get all webhooks for the user",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(v.array(webhookSchema)),
            },
          },
        },
      },
    }),
    validateScope("webhooks:read"),
    validator("param", v.object({ tenantId: v.string() })),
    authAndSetUsersInfo,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { tenantId } = c.req.valid("param");
        const webhooks = await getAllUsersWebhooks(userId, tenantId);
        return c.json(webhooks);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting webhooks: " + err,
        });
      }
    }
  );

  /**
   * Get all webhooks for the tenant
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/webhooks/global",
    authAndSetUsersInfo,
    isTenantMember,
    describeRoute({
      tags: ["webhooks"],
      summary: "Get all tenant webhooks",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(v.array(webhookSchema)),
            },
          },
        },
      },
    }),
    validateScope("webhooks:read"),
    validator("param", v.object({ tenantId: v.string() })),
    authAndSetUsersInfo,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { tenantId } = c.req.valid("param");
        const webhooks = await getAllOrganisationWebhooks(tenantId);
        return c.json(webhooks);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error getting webhooks: " + err,
        });
      }
    }
  );

  /**
   * Get a specific webhook by ID
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/webhooks/:id",
    authAndSetUsersInfo,
    isTenantMember,
    describeRoute({
      tags: ["webhooks"],
      summary: "Get a specific webhook by ID",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(webhookSchema),
            },
          },
        },
      },
    }),
    validateScope("webhooks:read"),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    authAndSetUsersInfo,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { id, tenantId } = c.req.valid("param");
        const webhook = await getWebhookById(id, userId, tenantId);
        if (!webhook) {
          throw new HTTPException(404, { message: "Webhook not found" });
        }
        return c.json(webhook);
      } catch (err) {
        if (err instanceof HTTPException) throw err;
        throw new HTTPException(500, {
          message: "Error getting webhook: " + err,
        });
      }
    }
  );

  /**
   * Update a webhook
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/webhooks/:id",
    authAndSetUsersInfo,
    isTenantMember,
    describeRoute({
      tags: ["webhooks"],
      summary: "Update a webhook",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(webhookSchema),
            },
          },
        },
      },
    }),
    validateScope("webhooks:write"),
    validator("json", updateWebhookSchema),
    validator(
      "param",
      v.object({ id: v.string(), tenantId: v.string() })
    ),
    authAndSetUsersInfo,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { id, tenantId } = c.req.valid("param");
        const parsed = c.req.valid("json");
        const webhook = await updateWebhook(id, parsed, userId, tenantId);
        if (!webhook) {
          throw new HTTPException(404, { message: "Webhook not found" });
        }
        return c.json(webhook);
      } catch (err) {
        if (err instanceof HTTPException) throw err;
        throw new HTTPException(500, {
          message: "Error updating webhook: " + err,
        });
      }
    }
  );

  /**
   * Delete a webhook
   */
  app.delete(
    API_BASE_PATH + "/tenant/:tenantId/webhooks/:id",
    authAndSetUsersInfo,
    isTenantMember,
    describeRoute({
      tags: ["webhooks"],
      summary: "Delete a webhook",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("webhooks:write"),
    validator(
      "param",
      v.object({ id: v.string(), tenantId: v.string() })
    ),
    authAndSetUsersInfo,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { id, tenantId } = c.req.valid("param");
        await deleteWebhook(id, userId, tenantId);
        return c.json(RESPONSES.SUCCESS);
      } catch (err) {
        throw new HTTPException(500, {
          message: "Error deleting webhook: " + err,
        });
      }
    }
  );

  /**
   * Register webhook (specifically for n8n integration)
   */

  app.post(
    API_BASE_PATH + "/tenant/:tenantId/webhooks/register/n8n",
    authAndSetUsersInfo,
    isTenantMember,
    describeRoute({
      tags: ["webhooks"],
      summary: "Register a webhook for n8n",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({ id: v.string(), success: v.boolean() })
              ),
            },
          },
        },
      },
    }),
    validateScope("webhooks:write"),
    validator(
      "json",
      v.object({
        name: v.string(),
        webhookUrl: v.string(),
        event: v.string(), // 'chatOutput' or 'tool'
        tenantId: v.string(),
        tenantWide: v.optional(v.boolean()),
        meta: v.optional(v.any()),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    async (c) => {
      try {
        const userId = c.get("usersId");
        const body = c.req.valid("json");
        const { tenantId } = c.req.valid("param");

        let insertData;

        // check event type
        if (body.event === "chatOutput") {
          insertData = {
            userId: userId,
            tenantId,
            name: body.name,
            type: "n8n" as const,
            event: "chat-output" as const,
            webhookUrl: body.webhookUrl,
            tenantWide: body.tenantWide ?? false,
          };
        } else if (body.event === "tool") {
          const data = {
            userId: userId,
            tenantId,
            name: normalizeToolName(body.name),
            type: "n8n" as const,
            event: "tool" as const,
            webhookUrl: body.webhookUrl,
            tenantWide: body.tenantWide ?? false,
            meta: body.meta ?? {},
          };
          insertData = v.parse(webhookSchema, data);
        } else {
          log.debug("Invalid event type", { event: body.event });
          throw new HTTPException(400, {
            message: "Invalid event type",
          });
        }

        const webhook = await createWebhook(userId, insertData);
        return c.json({
          id: webhook.id,
          success: true,
        });

        // Return format compatible with n8n expectations
      } catch (err) {
        log.error("Error registering webhook", { err });
        throw new HTTPException(500, {
          message: "Error registering webhook: " + err,
        });
      }
    }
  );

  /**
   * Add webhook check endpoint
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/webhooks/check",
    authAndSetUsersInfo,
    isTenantMember,
    describeRoute({
      tags: ["webhooks"],
      summary: "Check if a webhook exists",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  exists: v.boolean(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("webhooks:read"),
    validator("json", v.object({ webhookId: v.string() })),
    validator("param", v.object({ tenantId: v.string() })),
    authAndSetUsersInfo,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { webhookId } = c.req.valid("json");
        const { tenantId } = c.req.valid("param");

        const webhook = await getWebhookById(webhookId, userId, tenantId);
        return c.json({
          exists: !!webhook,
        });
      } catch (err) {
        return c.json({ exists: false });
      }
    }
  );

  /**
   * Trigger a webhook
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/webhooks/:id/trigger",
    authAndSetUsersInfo,
    isTenantMember,
    describeRoute({
      tags: ["webhooks"],
      summary: "Trigger a webhook",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("webhooks:write"),
    validator("json", v.any()),
    validator(
      "param",
      v.object({ id: v.string(), tenantId: v.string() })
    ),
    authAndSetUsersInfo,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const { id, tenantId } = c.req.valid("param");
        const body = c.req.valid("json");

        const result = await triggerWebhook(id, tenantId, {
          payload: body,
        });

        return c.json(result);
      } catch (err: any) {
        if (err instanceof WebhookTriggerError) {
          throw new HTTPException(500, {
            message: err.message,
          });
        }
        throw new HTTPException(500, {
          message: "Error triggering webhook: " + err,
        });
      }
    }
  );
}
