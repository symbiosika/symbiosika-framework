/**
 * Routes to manage user notifications
 * These routes are protected by JWT and CheckPermission middleware
 */

import type { FastAppHono } from "../../../types";
import { HTTPException } from "hono/http-exception";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../lib/utils/hono-middlewares";
import {
  getUserMessages,
  confirmMessage,
  confirmAllMessages,
} from "../../../lib/notifications";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { userMessagesSelectSchema } from "../../../lib/db/schema/users";

/**
 * Define notification routes
 */
export default function defineNotificationRoutes(
  app: FastAppHono,
  API_BASE_PATH: string = ""
) {
  const baseRoute = `${API_BASE_PATH}/user/notifications`;

  /**
   * GET /user/notifications
   * Get all unconfirmed messages for the current user
   */
  app.get(
    baseRoute,
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["notifications"],
      summary: "Get all unconfirmed messages for the current user",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(v.array(userMessagesSelectSchema)),
            },
          },
        },
      },
    }),
    async (c) => {
      try {
        const userId = c.get("usersId");
        if (!userId) {
          throw new HTTPException(401, {
            message: "User not authenticated",
          });
        }

        const messages = await getUserMessages(userId);

        return c.json(messages);
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error;
        }
        throw new HTTPException(500, {
          message: "Failed to get messages: " + (error as Error).message,
        });
      }
    }
  );

  /**
   * PATCH /user/notifications/:messageId/confirm
   * Mark a specific message as confirmed
   */
  app.patch(
    `${baseRoute}/:messageId/confirm`,
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["notifications"],
      summary: "Mark a specific message as confirmed",
      responses: {
        200: {
          description: "Message confirmed successfully",
          content: {
            "application/json": {
              schema: resolver(userMessagesSelectSchema),
            },
          },
        },
        404: {
          description: "Message not found",
        },
      },
    }),
    validator("param", v.object({ messageId: v.string() })),
    async (c) => {
      try {
        const userId = c.get("usersId");
        if (!userId) {
          throw new HTTPException(401, {
            message: "User not authenticated",
          });
        }

        const { messageId } = c.req.valid("param");

        const message = await confirmMessage(messageId, userId);

        return c.json(message);
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error;
        }
        throw new HTTPException(500, {
          message: "Failed to confirm message: " + (error as Error).message,
        });
      }
    }
  );

  /**
   * PATCH /user/notifications/confirm-all
   * Mark all messages as confirmed for the current user
   */
  app.patch(
    `${baseRoute}/confirm-all`,
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["notifications"],
      summary: "Mark all messages as confirmed for the current user",
      responses: {
        200: {
          description: "All messages confirmed successfully",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  message: v.string(),
                })
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      try {
        const userId = c.get("usersId");
        if (!userId) {
          throw new HTTPException(401, {
            message: "User not authenticated",
          });
        }

        await confirmAllMessages(userId);

        return c.json({ message: "All messages confirmed successfully" });
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error;
        }
        throw new HTTPException(500, {
          message:
            "Failed to confirm all messages: " + (error as Error).message,
        });
      }
    }
  );
}
