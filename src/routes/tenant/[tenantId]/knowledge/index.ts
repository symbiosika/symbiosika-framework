/**
 * Routes to manage the knowledge entries for each tenant
 * These routes are protected by JWT and CheckPermission middleware
 */
import type { SymbiosikaFrameworkHonoApp } from "../../../../types";
import * as v from "valibot";
import { HTTPException } from "hono/http-exception";
import {
  extractKnowledgeFromExistingDbEntry,
  extractKnowledgeFromText,
  extractKnowledgeInOneStep,
} from "../../../../lib/knowledge/add-knowledge";
import { parseDocument } from "../../../../lib/knowledge/parsing";
import {
  getFullSourceDocumentsForKnowledgeEntry,
  getKnowledgeEntries,
} from "../../../../lib/knowledge/get-knowledge";
import {
  deleteKnowledgeEntry,
  updateKnowledgeEntry,
  updateKnowledgeEntryText,
} from "../../../../lib/knowledge/update-knowledge";
import { RESPONSES } from "../../../../lib/responses";
import {
  getFullSourceDocumentsForSimilaritySearch,
  getNearestEmbeddings,
} from "../../../../lib/knowledge/similarity-search";
import {
  authAndSetUsersInfo,
  checkUserPermission,
} from "../../../../lib/utils/hono-middlewares";
import { validateOrganisationId } from "../../../../lib/utils/doublecheck-tenant";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi";
import { knowledgeEntrySchema } from "../../../../lib/db/db-schema";
import { isTenantAdmin, isTenantMember } from "../..";
import { validateScope } from "../../../../lib/utils/validate-scope";
import {
  applyPostProcessors,
  getAllPostProcessors,
} from "../../../../lib/knowledge/parsing/pre-processors";

const FileSourceType = {
  DB: "db",
  LOCAL: "local",
  URL: "url",
  TEXT: "text",
  EXTERNAL: "external",
} as const;

const generateKnowledgeValidation = v.object({
  tenantId: v.string(),
  sourceType: v.enum(FileSourceType),
  sourceId: v.optional(v.string()),
  sourceFileBucket: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  filters: v.optional(v.record(v.string(), v.string())),
  teamId: v.optional(v.string()),
  userId: v.optional(v.string()),
  userOwned: v.optional(v.boolean()),
  workspaceId: v.optional(v.string()),
  knowledgeGroupId: v.optional(v.string()),
  model: v.optional(v.string()), // mistral | llama | local
  usePostProcessors: v.optional(v.array(v.string())),
  extractImages: v.optional(v.boolean()),
  generateSummary: v.optional(v.boolean()),
  summaryCustomPrompt: v.optional(v.string()),
  summaryModel: v.optional(v.string()),
});
export type GenerateKnowledgeInput = v.InferOutput<
  typeof generateKnowledgeValidation
>;

const askKnowledgeValidation = v.object({
  question: v.string(),
  countChunks: v.optional(v.number()),
  addBeforeN: v.optional(v.number()),
  addAfterN: v.optional(v.number()),
  filterKnowledgeEntryIds: v.optional(v.array(v.string())),
  userOwned: v.optional(v.boolean()),
  teamId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  knowledgeGroupId: v.optional(v.string()),
});
export type AskKnowledgeInput = v.InferOutput<typeof askKnowledgeValidation>;

const parseDocumentValidation = v.object({
  sourceType: v.enum(FileSourceType),
  sourceId: v.optional(v.string()),
  sourceFileBucket: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  tenantId: v.string(),
  userOwned: v.optional(v.boolean()),
  knowledgeGroupId: v.optional(v.string()),
  teamId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
});
export type ParseDocumentInput = v.InferOutput<typeof parseDocumentValidation>;

const similaritySearchValidation = v.object({
  tenantId: v.string(),
  searchText: v.string(),
  n: v.optional(v.number()),
  addBeforeN: v.optional(v.number()),
  addAfterN: v.optional(v.number()),
  filterKnowledgeEntryIds: v.optional(v.array(v.string())),
  filterKnowledgeGroupIds: v.optional(v.array(v.string())),
  filterTeamIds: v.optional(v.array(v.string())),
  filterUserOwned: v.optional(v.boolean()),
  filterWorkspaceIds: v.optional(v.array(v.string())),
  filter: v.optional(v.record(v.string(), v.array(v.string()))),
  filterName: v.optional(v.array(v.string())),
  fullDocument: v.optional(v.boolean()),
});

const addFromTextValidation = v.object({
  tenantId: v.string(),
  text: v.string(),
  title: v.string(),
  filters: v.optional(v.record(v.string(), v.string())),
  teamId: v.optional(v.string()),
  userId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  knowledgeGroupId: v.optional(v.string()),
  userOwned: v.optional(v.boolean()),
  meta: v.optional(
    v.object({
      sourceUri: v.string(),
      sourceId: v.string(),
    })
  ),
  usePostProcessors: v.optional(v.array(v.string())),
});

const addFromUrlValidation = v.object({
  tenantId: v.string(),
  url: v.string(),
  filters: v.optional(v.record(v.string(), v.string())),
  teamId: v.optional(v.string()),
  userId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  knowledgeGroupId: v.optional(v.string()),
  userOwned: v.optional(v.boolean()),
  usePostProcessors: v.optional(v.array(v.string())),
});

const uploadAndLearnValidation = v.object({
  tenantId: v.string(),
  filters: v.optional(v.record(v.string(), v.string())),
  teamId: v.optional(v.string()),
  userId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  knowledgeGroupId: v.optional(v.string()),
  userOwned: v.optional(v.boolean()),
  text: v.optional(v.string()),
  meta: v.optional(
    v.object({
      sourceUri: v.string(),
      sourceId: v.string(),
    })
  ),
  model: v.optional(v.string()), // mistral | llama | local
  usePostProcessors: v.optional(v.array(v.string())),
  extractImages: v.optional(v.boolean()),
  generateSummary: v.optional(v.boolean()),
  summaryCustomPrompt: v.optional(v.string()),
  summaryModel: v.optional(v.string()),
});

const checkForSyncValidation = v.object({
  externalId: v.string(),
  lastChange: v.optional(v.string()),
  lastHash: v.optional(v.string()),
});

const syncKnowledgeValidation = v.object({
  externalId: v.string(),
  title: v.string(),
  text: v.string(),
  lastChange: v.optional(v.string()),
  lastHash: v.optional(v.string()),
  filters: v.optional(v.record(v.string(), v.string())),
  meta: v.optional(v.record(v.string(), v.any())),
  teamId: v.optional(v.string()),
  userId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  knowledgeGroupId: v.optional(v.string()),
  userOwned: v.optional(v.boolean()),
});

export default function defineRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH: string) {
  /**
   * Get all knowledge entries
   * URL params:
   * - limit: number
   * - page: number
   * - teamId: string
   * - userId: string
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/entries",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get all knowledge entries",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(v.array(knowledgeEntrySchema)),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator(
      "query",
      v.object({
        limit: v.optional(v.string()),
        page: v.optional(v.string()),
        teamId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        knowledgeGroupId: v.optional(v.string()),
        userOwned: v.optional(v.string()),
      })
    ),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const {
          limit: limitStr,
          page: pageStr,
          teamId,
          workspaceId,
          knowledgeGroupId,
          userOwned,
        } = c.req.valid("query");
        const { tenantId } = c.req.valid("param");
        const usersId = c.get("usersId");

        const limit = parseInt(limitStr ?? "100");
        const page = parseInt(pageStr ?? "0");

        const r = await getKnowledgeEntries({
          limit,
          page,
          tenantId,
          userId: usersId,
          teamId,
          workspaceId,
          knowledgeGroupId:
            knowledgeGroupId === "null" ? null : knowledgeGroupId,
          ...(userOwned === "true" ? { userOwned: true } : {}),
        });
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Get a full source document for a knowledge entry by ID
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/entries/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Get a full source document for a knowledge entry by ID",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(knowledgeEntrySchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const usersId = c.get("usersId");
        const r = await getFullSourceDocumentsForKnowledgeEntry(
          id,
          tenantId,
          usersId
        );

        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Update a knowledge entry by ID
   * Name and assignments can be updated
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/entries/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Update a knowledge entry by ID. Name and assignments can be updated.",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(knowledgeEntrySchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    validator(
      "json",
      v.object({
        name: v.optional(v.string()),
        teamId: v.optional(v.nullable(v.string())),
        workspaceId: v.optional(v.nullable(v.string())),
        knowledgeGroupId: v.optional(v.nullable(v.string())),
        userOwned: v.optional(v.boolean()),
        description: v.optional(v.string()),
        abstract: v.optional(v.string()),
      })
    ),
    isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const usersId = c.get("usersId");
        const data = c.req.valid("json");

        const r = await updateKnowledgeEntry(id, tenantId, usersId, data);

        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Update the text content of a knowledge entry
   * This will delete all existing chunks and recreate them with fresh embeddings
   */
  app.put(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/entries/:id/text",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Update the text content of a knowledge entry. This will delete all existing chunks and recreate them with fresh embeddings.",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(knowledgeEntrySchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    validator(
      "json",
      v.object({
        text: v.string(),
      })
    ),
    isTenantAdmin,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const usersId = c.get("usersId");
        const { text } = c.req.valid("json");

        const r = await updateKnowledgeEntryText(id, tenantId, usersId, text);

        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Delete a knowledge entry by ID
   * URL params:
   * - tenantId: string
   */
  app.delete(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/entries/:id",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Delete a knowledge entry by ID",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("param", v.object({ tenantId: v.string(), id: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const { tenantId, id } = c.req.valid("param");
        const usersId = c.get("usersId");
        await deleteKnowledgeEntry(id, tenantId, usersId);
        return c.json(RESPONSES.SUCCESS);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Similarity search
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/similarity-search",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Search for similar documents",
      responses: {
        200: {
          description: "Successful response",
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("json", similaritySearchValidation),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const userId = c.get("usersId");
        const body = c.req.valid("json");
        const { tenantId } = c.req.valid("param");
        validateOrganisationId(body, tenantId);

        if (body.searchText.length < 3) {
          throw new Error("Search text must be at least 3 characters long");
        }

        if (body.fullDocument) {
          const r = await getFullSourceDocumentsForSimilaritySearch({
            tenantId: body.tenantId,
            searchText: body.searchText,
            n: body.n,
            filterKnowledgeEntryIds: body.filterKnowledgeEntryIds,
            filter: body.filter,
            filterName: body.filterName,
            userId,
          });
          return c.json(r);
        }

        const r = await getNearestEmbeddings({
          tenantId: body.tenantId,
          searchText: body.searchText,
          n: body.n,
          addBeforeN: body.addBeforeN,
          addAfterN: body.addAfterN,
          filterKnowledgeEntryIds: body.filterKnowledgeEntryIds,
          filter: body.filter,
          filterName: body.filterName,
        });
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Call the knowledge extraction from a document to generate embeddings in the database
   * A document can be a plain text in the DB, a markdown file, an PDF file, an image, etc.
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/extract-knowledge",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Extract knowledge from a document",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  id: v.string(),
                  ok: v.boolean(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("json", generateKnowledgeValidation),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const body = c.req.valid("json");
        const { tenantId } = c.req.valid("param");
        validateOrganisationId(body, tenantId);

        const r = await extractKnowledgeFromExistingDbEntry({
          ...body,
          tenantId,
          userId: c.get("usersId"),
        });
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Upload a file, learn from it, and then delete it
   * This endpoint combines file upload and knowledge extraction in one step
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/upload-and-extract",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Upload a file and extract knowledge in one step",
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: v.object({
              file: v.any(),
              teamId: v.optional(v.string()),
              workspaceId: v.optional(v.string()),
              knowledgeGroupId: v.optional(v.string()),
              userOwned: v.optional(v.string()),
              filters: v.optional(v.string()),
            }),
          },
          "application/json": {
            schema: uploadAndLearnValidation,
          },
        },
      },
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  id: v.string(),
                  ok: v.boolean(),
                })
              ),
            },
          },
        },
        400: {
          description: "Bad request",
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      const tenantId = c.req.param("tenantId");
      const contentType = c.req.header("content-type");
      const userId = c.get("usersId");

      let data;
      let file;
      let teamId;
      let workspaceId;
      let knowledgeGroupId;
      let userOwned;
      let filters;
      let generateSummary;
      let summaryCustomPrompt;
      let summaryModel;
      let extractImages;

      if (contentType && contentType.includes("multipart/form-data")) {
        const form = await c.req.formData();
        teamId = form.get("teamId")?.toString();

        if (teamId && teamId === "") {
          teamId = undefined;
        }
        workspaceId = form.get("workspaceId")?.toString();
        if (workspaceId && workspaceId === "") {
          workspaceId = undefined;
        }

        knowledgeGroupId = form.get("knowledgeGroupId")?.toString();
        if (knowledgeGroupId && knowledgeGroupId === "") {
          knowledgeGroupId = undefined;
        }

        extractImages = form.get("extractImages")?.toString() === "true";
        userOwned = form.get("userOwned")?.toString() === "true";
        generateSummary = form.get("generateSummary")?.toString() === "true";
        summaryCustomPrompt = form.get("summaryCustomPrompt")?.toString();
        summaryModel = form.get("summaryModel")?.toString();

        try {
          filters = form.get("filters")
            ? JSON.parse(form.get("filters")?.toString() || "{}")
            : undefined;
        } catch (e) {
          throw new HTTPException(400, {
            message: "Error parsing filters from form-data.",
          });
        }
        file = form.get("file") as File;
        data = {
          userId,
          tenantId,
          teamId,
          workspaceId,
          knowledgeGroupId,
          userOwned,
          filters,
          extractImages,
          generateSummary,
          summaryCustomPrompt,
          summaryModel,
        };
      } else {
        data = await c.req.json();
        data = {
          ...data,
          tenantId,
          userId,
        };
      }

      try {
        const parsedData = v.parse(uploadAndLearnValidation, data);
        const r = await extractKnowledgeInOneStep(
          { ...parsedData, file },
          true
        );
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Add a text knowledge entry from a Text
   * This will create a knowledge-text entry
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/from-text",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "Add a text knowledge entry from text",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(knowledgeEntrySchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("json", addFromTextValidation),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const data = c.req.valid("json");
        const { tenantId } = c.req.valid("param");
        validateOrganisationId(data, tenantId);

        const text = await applyPostProcessors(
          data.text,
          tenantId,
          data.usePostProcessors
        );

        const r = await extractKnowledgeFromText({
          userId: c.get("usersId"),
          tenantId: data.tenantId,
          title: data.title,
          text,
          filters: data.filters,
          teamId: data.teamId,
          workspaceId: data.workspaceId,
          knowledgeGroupId: data.knowledgeGroupId,
          userOwned: data.userOwned,
          sourceExternalId: data.meta?.sourceId ?? data.title,
          sourceType: "external",
          sourceFileBucket: "default",
          sourceUrl: data.meta?.sourceUri ?? data.title,
          includesLocalImages: false,
        });

        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * List all registered post processors (read-only)
   */
  app.get(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/post-processors",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary: "List all registered post processors",
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    name: v.string(),
                    label: v.string(),
                    description: v.string(),
                  })
                )
              ),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        // No tenant-specific filtering for now
        const processors = await getAllPostProcessors();
        return c.json(processors);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );
}
