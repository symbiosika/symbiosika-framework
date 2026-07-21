/**
 * Routes to manage the knowledge entries for each tenant
 * These routes are protected by JWT and CheckPermission middleware
 */
import type { SymbiosikaFrameworkHonoApp } from "../../../../types";
import * as v from "valibot";
import { HTTPException } from "hono/http-exception";
import {
  createKnowledgeIngestJob,
  storeIngestFileInDb,
} from "../../../../lib/knowledge/ingestion-jobs";
import { jobsSelectSchema } from "../../../../lib/db/schema/jobs";
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
import { getAllPostProcessors } from "../../../../lib/knowledge/parsing/post-processors";
import { enqueueReEmbedding } from "../../../../lib/knowledge/re-embed";

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
  teamId: v.optional(v.string()),
  userId: v.optional(v.string()),
  userOwned: v.optional(v.boolean()),
  workspaceId: v.optional(v.string()),
  knowledgeGroupId: v.optional(v.string()),
  model: v.optional(v.string()), // symbiosika-parse-v1 | mistral | mistral-openrouter | llama
  usePostProcessors: v.optional(v.array(v.string())),
  extractImages: v.optional(v.boolean()),
  generateSummary: v.optional(v.boolean()),
  summaryCustomPrompt: v.optional(v.string()),
  summaryModel: v.optional(v.string()),
  // When true, a success/error message is pushed into the user's notification
  // queue once the background job finishes.
  notifyOnCompletion: v.optional(v.boolean()),
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
  filterName: v.optional(v.array(v.string())),
  fullDocument: v.optional(v.boolean()),
});

const addFromTextValidation = v.object({
  tenantId: v.string(),
  text: v.string(),
  title: v.string(),
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
  notifyOnCompletion: v.optional(v.boolean()),
});

const addFromUrlValidation = v.object({
  tenantId: v.string(),
  url: v.string(),
  teamId: v.optional(v.string()),
  userId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  knowledgeGroupId: v.optional(v.string()),
  userOwned: v.optional(v.boolean()),
  usePostProcessors: v.optional(v.array(v.string())),
  notifyOnCompletion: v.optional(v.boolean()),
});

const uploadAndLearnValidation = v.object({
  tenantId: v.string(),
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
  model: v.optional(v.string()), // symbiosika-parse-v1 | mistral | mistral-openrouter | llama
  usePostProcessors: v.optional(v.array(v.string())),
  extractImages: v.optional(v.boolean()),
  generateSummary: v.optional(v.boolean()),
  summaryCustomPrompt: v.optional(v.string()),
  summaryModel: v.optional(v.string()),
  notifyOnCompletion: v.optional(v.boolean()),
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
            tenantId: tenantId,
            searchText: body.searchText,
            n: body.n,
            filterKnowledgeEntryIds: body.filterKnowledgeEntryIds,
            filterName: body.filterName,
            userId,
          });
          return c.json(r);
        }

        const r = await getNearestEmbeddings({
          tenantId: tenantId,
          searchText: body.searchText,
          n: body.n,
          addBeforeN: body.addBeforeN,
          addAfterN: body.addAfterN,
          filterKnowledgeEntryIds: body.filterKnowledgeEntryIds,
          filterName: body.filterName,
        });
        return c.json(r);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Start a background job that extracts knowledge from a document to generate
   * embeddings in the database. A document can be a plain text in the DB, a
   * markdown file, a PDF file, an image, etc.
   *
   * NOTE: this endpoint no longer waits for the extraction to finish. It
   * returns the created Job immediately; poll `GET /tenant/:tenantId/jobs/:id`
   * for status and the `{ id, ok }` result.
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/extract-knowledge",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Start a background job to extract knowledge from a document (returns the Job)",
      responses: {
        200: {
          description: "The created ingestion job",
          content: {
            "application/json": {
              schema: resolver(jobsSelectSchema),
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
        const userId = c.get("usersId");

        const { tenantId: _t, notifyOnCompletion, ...params } = body;
        const job = await createKnowledgeIngestJob(
          { kind: "rag-existing", tenantId, userId, notifyOnCompletion, params },
          tenantId,
          userId
        );
        return c.json(job);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Upload a file and start a background job that learns from it.
   *
   * The uploaded file is stashed in DB storage and processed asynchronously;
   * the temporary file is deleted once the job has run. This endpoint returns
   * the created Job immediately instead of waiting for parsing + embedding.
   * Poll `GET /tenant/:tenantId/jobs/:id` for status and the `{ id, ok }`
   * result.
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/upload-and-extract",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Upload a file and start a background job to extract knowledge (returns the Job)",
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: v.object({
              file: v.any(),
              teamId: v.optional(v.string()),
              workspaceId: v.optional(v.string()),
              knowledgeGroupId: v.optional(v.string()),
              userOwned: v.optional(v.string()),
            }),
          },
          "application/json": {
            schema: uploadAndLearnValidation,
          },
        },
      },
      responses: {
        200: {
          description: "The created ingestion job",
          content: {
            "application/json": {
              schema: resolver(jobsSelectSchema),
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
      const { tenantId } = c.req.valid("param");
      const contentType = c.req.header("content-type");
      const userId = c.get("usersId");

      let data;
      let file;
      let teamId;
      let workspaceId;
      let knowledgeGroupId;
      let userOwned;
      let generateSummary;
      let summaryCustomPrompt;
      let summaryModel;
      let extractImages;
      let notifyOnCompletion;

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
        notifyOnCompletion =
          form.get("notifyOnCompletion")?.toString() === "true";

        file = form.get("file") as File;
        data = {
          userId,
          tenantId,
          teamId,
          workspaceId,
          knowledgeGroupId,
          userOwned,
          extractImages,
          generateSummary,
          summaryCustomPrompt,
          summaryModel,
          notifyOnCompletion,
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

        if (!(file instanceof File)) {
          throw new HTTPException(400, {
            message: "No file provided for upload-and-extract.",
          });
        }

        // Stash the file so the background job can read it later, then hand
        // back the job. The job deletes the temporary file when it is done.
        const storage = await storeIngestFileInDb(file, tenantId);
        const {
          tenantId: _t,
          userId: _u,
          notifyOnCompletion: notify,
          ...options
        } = parsedData;
        const job = await createKnowledgeIngestJob(
          {
            kind: "rag-upload",
            tenantId,
            userId,
            notifyOnCompletion: notify,
            storage,
            deleteAfter: true,
            options,
          },
          tenantId,
          userId
        );
        return c.json(job);
      } catch (e) {
        if (e instanceof HTTPException) {
          throw e;
        }
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Add a text knowledge entry from a Text.
   *
   * Starts a background job (post-processing + chunking + embedding) and
   * returns the created Job immediately. Poll
   * `GET /tenant/:tenantId/jobs/:id` for status and the `{ id, ok }` result.
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/from-text",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Start a background job to add a text knowledge entry (returns the Job)",
      responses: {
        200: {
          description: "The created ingestion job",
          content: {
            "application/json": {
              schema: resolver(jobsSelectSchema),
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
        const userId = c.get("usersId");

        const job = await createKnowledgeIngestJob(
          {
            kind: "rag-text",
            tenantId,
            userId,
            notifyOnCompletion: data.notifyOnCompletion,
            params: {
              text: data.text,
              title: data.title,
              teamId: data.teamId,
              workspaceId: data.workspaceId,
              knowledgeGroupId: data.knowledgeGroupId,
              userOwned: data.userOwned,
              meta: data.meta,
              usePostProcessors: data.usePostProcessors,
            },
          },
          tenantId,
          userId
        );

        return c.json(job);
      } catch (e) {
        throw new HTTPException(400, { message: e + "" });
      }
    }
  );

  /**
   * Add a knowledge entry from a URL (HTML page or linked PDF).
   *
   * Starts a background job that fetches the URL, extracts the readable
   * article (Mozilla Readability + Turndown) or parses a linked PDF, and
   * embeds it. Returns the created Job immediately; poll
   * `GET /tenant/:tenantId/jobs/:id` for status and the `{ id, ok }` result.
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/from-url",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Start a background job to add a knowledge entry from a URL (returns the Job)",
      responses: {
        200: {
          description: "The created ingestion job",
          content: {
            "application/json": {
              schema: resolver(jobsSelectSchema),
            },
          },
        },
      },
    }),
    validateScope("knowledge:read"),
    validator("json", addFromUrlValidation),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantMember,
    async (c) => {
      try {
        const data = c.req.valid("json");
        const { tenantId } = c.req.valid("param");
        validateOrganisationId(data, tenantId);
        const userId = c.get("usersId");

        // Cheap synchronous guard so obviously-bad input fails fast instead of
        // via a failed job.
        if (
          !data.url.startsWith("http://") &&
          !data.url.startsWith("https://")
        ) {
          throw new Error("URL must start with http:// or https://");
        }

        const job = await createKnowledgeIngestJob(
          {
            kind: "rag-url",
            tenantId,
            userId,
            notifyOnCompletion: data.notifyOnCompletion,
            params: {
              url: data.url,
              teamId: data.teamId,
              workspaceId: data.workspaceId,
              knowledgeGroupId: data.knowledgeGroupId,
              userOwned: data.userOwned,
              usePostProcessors: data.usePostProcessors,
            },
          },
          tenantId,
          userId
        );

        return c.json(job);
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

  /**
   * Trigger re-embedding after an embedding model/provider change — enqueue
   * one background job per knowledge entry whose chunks are not on the
   * currently configured embedding model. Admin only. Safe to call repeatedly
   * (already queued/running entries are skipped).
   */
  app.post(
    API_BASE_PATH + "/tenant/:tenantId/knowledge/re-embed",
    authAndSetUsersInfo,
    checkUserPermission,
    describeRoute({
      tags: ["knowledge"],
      summary:
        "Enqueue re-embed jobs for entries not on the configured embedding model",
      responses: {
        200: {
          description: "Enqueue result",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  enqueued: v.number(),
                  outdatedEntries: v.number(),
                })
              ),
            },
          },
        },
      },
    }),
    validateScope("knowledge:write"),
    validator("param", v.object({ tenantId: v.string() })),
    isTenantAdmin,
    async (c) => {
      const { tenantId } = c.req.valid("param");
      return c.json(await enqueueReEmbedding(tenantId));
    }
  );
}
