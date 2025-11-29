import type { FastAppHono } from "../../../../../types";
import * as v from "valibot";
import { HTTPException } from "hono/http-exception";
import { getKnowledgeChunkById } from "../../../../../lib/knowledge/chunks";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../../lib/utils/hono-middlewares";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import { knowledgeChunksSchema } from "../../../../../lib/db/db-schema";
import { isTenantMember } from "../../..";
import { validateScope } from "../../../../../lib/utils/validate-scope";

export default function defineRoutesForKnowledgeChunks(
  app: FastAppHono,
  API_BASE_PATH: string
) {
  /**
   * Get a knowledge chunk by ID
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/chunks/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get a knowledge chunk by ID",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(knowledgeChunksSchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "param",
      v.object({ tenantId: v.string(), id: v.string() })
    ),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const userId = c.get("usersId");

        const chunk = await getKnowledgeChunkById(id, tenantId, userId);
        return c.json(chunk);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );
}
