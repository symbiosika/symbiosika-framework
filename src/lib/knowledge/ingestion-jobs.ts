/**
 * Background-job ingestion for documents (PDF, files, URLs, plain text).
 *
 * The knowledge ingestion routes used to parse + chunk + embed documents
 * synchronously inside the HTTP request. Parsing a large PDF (external OCR
 * services that busy-poll) plus embedding every chunk can take minutes and
 * held the request open the whole time.
 *
 * This module moves that work onto the framework's existing job queue
 * (`src/lib/jobs`). The routes now:
 *   1. persist the input (store the uploaded file, keep the URL/text in the
 *      job metadata),
 *   2. create a `knowledge:ingest` job, and
 *   3. return the Job immediately.
 *
 * A UI polls `GET /tenant/:tenantId/jobs/:jobId` and decides what to do with
 * the result once `status === "completed"`. The handler's return value (e.g.
 * `{ id, ok }` for a knowledge entry, or `{ knowledgeText, blocks }` for a
 * wiki page) is stored on `job.result`.
 *
 * A single job type (`knowledge:ingest`) covers every ingestion flavour; the
 * `kind` discriminator on the metadata selects the concrete work.
 */

import { eq } from "drizzle-orm";
import { createJob, getJob } from "../jobs";
import type { JobHandlerRegister } from "../jobs";
import { getDb } from "../db/db-connection";
import { jobs, type Job } from "../db/schema/jobs";
import {
  saveFileToDb,
  getFileFromDb,
  deleteFileFromDB,
} from "../storage/db";
import {
  extractKnowledgeInOneStep,
  extractKnowledgeFromExistingDbEntry,
  extractKnowledgeFromUrl,
  extractKnowledgeFromPlainText,
} from "./add-knowledge";
import {
  importKnowledgeTextFromFile,
  importKnowledgeTextFromUrl,
  type ImportKnowledgeTextOptions,
} from "./knowledge-text-import";
import log from "../log";

/** The single job type used for all document ingestion flavours. */
export const KNOWLEDGE_INGEST_JOB_TYPE = "knowledge:ingest";

/** Bucket used to stash uploaded files until the job has processed them. */
export const KNOWLEDGE_INGEST_BUCKET = "knowledge-ingest-jobs";

/**
 * Reference to an uploaded file that was stashed in the DB storage so a job
 * can pick it up later. Kept minimal + JSON-serialisable (job metadata is
 * `jsonb`).
 */
export type StoredIngestFile = {
  storageType: "db";
  bucket: string;
  fileId: string;
  fileName: string;
};

/** Options forwarded to `extractKnowledgeInOneStep` for an uploaded file. */
type RagUploadOptions = {
  teamId?: string;
  workspaceId?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  meta?: { sourceUri: string; sourceId: string };
  model?: string;
  usePostProcessors?: string[];
  generateSummary?: boolean;
  summaryCustomPrompt?: string;
  summaryModel?: string;
  extractImages?: boolean;
};

/** Params for extracting knowledge from an already-stored source (db/local/url/text). */
type RagExistingParams = {
  sourceType: "db" | "local" | "url" | "text" | "external";
  sourceId?: string;
  sourceFileBucket?: string;
  sourceUrl?: string;
  metadata?: Record<string, string | number | boolean | undefined>;
  teamId?: string;
  workspaceId?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  model?: string;
  extractImages?: boolean;
  generateSummary?: boolean;
  summaryCustomPrompt?: string;
  summaryModel?: string;
  usePostProcessors?: string[];
};

type RagUrlParams = {
  url: string;
  teamId?: string;
  workspaceId?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  usePostProcessors?: string[];
};

type RagTextParams = {
  text: string;
  title: string;
  teamId?: string;
  workspaceId?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  meta?: { sourceUri: string; sourceId: string };
  usePostProcessors?: string[];
};

/** Options forwarded to `importKnowledgeTextFrom*` (minus tenantId/userId). */
type TextImportOptions = Omit<ImportKnowledgeTextOptions, "tenantId" | "userId">;

/**
 * Fields shared by every ingest-job variant: tenant/user context and the
 * opt-in flag that makes a finished job push a success/error message into the
 * owning user's notification queue (handled generically by the job engine, see
 * `src/lib/jobs`).
 */
type KnowledgeIngestJobBase = {
  tenantId: string;
  userId?: string;
  /**
   * When true, a success/error message is pushed into the owning user's
   * notification queue when the job finishes. Requires `userId`.
   */
  notifyOnCompletion?: boolean;
};

/**
 * Discriminated metadata for a `knowledge:ingest` job. Every variant carries
 * the shared base fields plus a `kind` selecting the work.
 */
export type KnowledgeIngestJobMetadata = KnowledgeIngestJobBase &
  (
    | {
        kind: "rag-upload";
        storage: StoredIngestFile;
        deleteAfter: boolean;
        options: RagUploadOptions;
      }
    | {
        kind: "rag-existing";
        params: RagExistingParams;
      }
    | {
        kind: "rag-url";
        params: RagUrlParams;
      }
    | {
        kind: "rag-text";
        params: RagTextParams;
      }
    | {
        kind: "text-import-file";
        storage: StoredIngestFile;
        deleteAfter: boolean;
        options: TextImportOptions;
      }
    | {
        kind: "text-import-url";
        params: { url: string; options: TextImportOptions };
      }
  );

/**
 * Stash an uploaded file in DB storage so a background job can process it
 * later. Returns a JSON-serialisable reference to embed into the job metadata.
 */
export const storeIngestFileInDb = async (
  file: File,
  tenantId: string
): Promise<StoredIngestFile> => {
  const saved = await saveFileToDb(file, KNOWLEDGE_INGEST_BUCKET, tenantId);
  return {
    storageType: "db",
    bucket: KNOWLEDGE_INGEST_BUCKET,
    fileId: saved.id,
    fileName: saved.name,
  };
};

const deleteStoredIngestFile = async (
  storage: StoredIngestFile,
  tenantId: string
) => {
  try {
    await deleteFileFromDB(storage.fileId, storage.bucket, tenantId);
  } catch (e) {
    log.error(
      `Failed to delete temporary ingest file ${storage.fileId} in bucket ${storage.bucket}: ${e}`
    );
  }
};

/**
 * The actual work of a `knowledge:ingest` job. Reconstructs the input from the
 * job metadata and calls the same ingestion helpers the synchronous routes
 * used to call directly. Returns the value stored on `job.result`.
 */
export const processKnowledgeIngestJob = async (
  metadata: KnowledgeIngestJobMetadata
): Promise<unknown> => {
  switch (metadata.kind) {
    case "rag-upload": {
      const file = await getFileFromDb(
        metadata.storage.fileId,
        metadata.storage.bucket,
        metadata.tenantId
      );
      try {
        return await extractKnowledgeInOneStep(
          { ...metadata.options, tenantId: metadata.tenantId, file },
          true
        );
      } finally {
        if (metadata.deleteAfter) {
          await deleteStoredIngestFile(metadata.storage, metadata.tenantId);
        }
      }
    }

    case "rag-existing":
      return await extractKnowledgeFromExistingDbEntry({
        ...metadata.params,
        tenantId: metadata.tenantId,
        userId: metadata.userId,
      });

    case "rag-url":
      return await extractKnowledgeFromUrl({
        ...metadata.params,
        tenantId: metadata.tenantId,
        userId: metadata.userId,
      });

    case "rag-text":
      return await extractKnowledgeFromPlainText({
        ...metadata.params,
        tenantId: metadata.tenantId,
        userId: metadata.userId,
      });

    case "text-import-file": {
      const file = await getFileFromDb(
        metadata.storage.fileId,
        metadata.storage.bucket,
        metadata.tenantId
      );
      try {
        return await importKnowledgeTextFromFile(file, {
          ...metadata.options,
          tenantId: metadata.tenantId,
          userId: metadata.userId,
        });
      } finally {
        if (metadata.deleteAfter) {
          await deleteStoredIngestFile(metadata.storage, metadata.tenantId);
        }
      }
    }

    case "text-import-url":
      return await importKnowledgeTextFromUrl(metadata.params.url, {
        ...metadata.params.options,
        tenantId: metadata.tenantId,
        userId: metadata.userId,
      });

    default: {
      // Exhaustiveness guard — a new kind must be handled above.
      const _exhaustive: never = metadata;
      throw new Error(
        `Unknown knowledge ingest job kind: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
};

/**
 * Handler registration for the framework's built-in `knowledge:ingest` job.
 * Wired up in `src/index.ts` alongside any consumer-provided job handlers.
 */
export const knowledgeIngestJobRegister: JobHandlerRegister = {
  type: KNOWLEDGE_INGEST_JOB_TYPE,
  handler: {
    async execute(metadata: KnowledgeIngestJobMetadata) {
      return await processKnowledgeIngestJob(metadata);
    },
  },
};

/**
 * Create a `knowledge:ingest` job and (optionally) stamp the creating user on
 * it. Returns the created Job, which the route hands straight back to the
 * caller so a UI can poll for progress/result.
 */
export const createKnowledgeIngestJob = async (
  metadata: KnowledgeIngestJobMetadata,
  tenantId: string,
  userId?: string
): Promise<Job> => {
  const job = await createJob(KNOWLEDGE_INGEST_JOB_TYPE, metadata, tenantId);
  if (userId) {
    await getDb().update(jobs).set({ userId }).where(eq(jobs.id, job.id));
    return await getJob(job.id);
  }
  return job;
};
