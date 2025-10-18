/**
 * Public route to check if the server is online
 */

// import {
//   authAndSetUsersInfo,
//   checkUserPermission,
// } from "../../lib/utils/hono-middlewares";
import type { FastAppHono } from "../../types";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import * as v from "valibot";

/**
 * Define the plugin management routes
 */
export default function definePingRoute(app: FastAppHono, basePath: string) {
  /**
   * Ping and internet check endpoint
   */
  app.get(
    basePath + "/ping",
    describeRoute({
      tags: ["admin"],
      summary: "Health check endpoint",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  online: v.boolean(),
                  canConnectToInternet: v.boolean(),
                })
              ),
            },
          },
        },
      },
    }),
    validator("query", v.object({})),
    async (c) => {
      let canConnectToInternet = false;
      try {
        const response = await fetch("https://www.github.com");
        canConnectToInternet = response.ok;
      } catch (error) {
        canConnectToInternet = false;
      }

      return c.json({
        online: true,
        canConnectToInternet,
      });
    }
  );
}
