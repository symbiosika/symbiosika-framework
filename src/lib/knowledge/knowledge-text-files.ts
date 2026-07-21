/**
 * Images (and other file attachments) for knowledgeText pages,
 * with reference tracking so no orphaned blobs accumulate.
 *
 * Lifecycle:
 *
 *   1. Upload (`uploadKnowledgeTextImage`) stores the image in the "knowledge"
 *      bucket and stamps it with a short expiry — an upload that never
 *      makes it into a saved page cleans itself up.
 *   2. The editor embeds the returned markdown (`![alt](…/files/db/knowledge/<id>.<ext>)`)
 *      into a block. On every content save the file references of the page
 *      are re-extracted (same approach as page links):
 *        - newly referenced files lose their expiry (kept forever)
 *        - files that lost their LAST reference get a grace-period expiry,
 *          so a quick undo re-rescues them
 *   3. Deleting a page marks its exclusively-referenced files the same way.
 *   4. A weekly cron (`cleanupExpiredFiles`) deletes every file whose
 *      expiry has passed — index-only, works for the whole files table.
 */

import { and, eq, inArray, lt, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { files } from "../db/schema/files";
import { knowledgeTextFile } from "../db/schema/knowledge";
import { saveFileToDb } from "../storage/db";
import {
  getKnowledgeTextById,
  checkKnowledgeTextWritePermission,
} from "./knowledge-texts";
import log from "../log";

/** Bucket for files that belong to knowledge pages */
export const KNOWLEDGE_FILES_BUCKET = "knowledge";

/** Uploads that never get referenced by a saved page expire after this */
export const UNREFERENCED_UPLOAD_TTL_HOURS = 24;

/** Files that lost their last reference are kept this long (undo window,
 *  history snapshots) before the cleanup cron removes them */
export const ORPHANED_FILE_GRACE_DAYS = 7;

export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

type Context = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  includeHidden?: boolean;
};

const hoursFromNow = (hours: number): string =>
  new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

/**
 * Extract the file ids of knowledge-bucket files referenced in a page's
 * content. Matches the URL shape produced by the upload
 * (`…/files/db/knowledge/<uuid>.<ext>`) in markdown and html alike.
 */
export const extractKnowledgeFileIds = (content: string): string[] => {
  const pattern =
    /\/files\/db\/knowledge\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  const ids = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    ids.add(match[1]!.toLowerCase());
  }
  return [...ids];
};

export type UploadKnowledgeTextImageResult = {
  fileId: string;
  /** API path to fetch the image (auth required, files:read scope) */
  path: string;
  /** ready-to-insert markdown snippet for the editor */
  markdown: string;
};

/**
 * Upload an image for a knowledge page into the "knowledge" bucket. The file starts
 * with a short expiry and becomes permanent once a page save references it.
 */
export const uploadKnowledgeTextImage = async (
  knowledgeTextId: string,
  file: File,
  context: Context,
  options?: { alt?: string }
): Promise<UploadKnowledgeTextImageResult> => {
  // page must be visible AND writable for the caller
  const page = await getKnowledgeTextById(knowledgeTextId, context);
  await checkKnowledgeTextWritePermission(page, context);

  if (!(file.type ?? "").toLowerCase().startsWith("image/")) {
    throw new Error(
      `Only image uploads are allowed (got "${file.type || "unknown"}")`
    );
  }
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(
      `Image exceeds the maximum size of ${MAX_IMAGE_SIZE_BYTES / (1024 * 1024)} MB`
    );
  }

  const saved = await saveFileToDb(file, KNOWLEDGE_FILES_BUCKET, context.tenantId);

  // unreferenced uploads clean themselves up
  await getDb()
    .update(files)
    .set({ expiresAt: hoursFromNow(UNREFERENCED_UPLOAD_TTL_HOURS) })
    .where(eq(files.id, saved.id));

  const alt = options?.alt ?? file.name ?? "image";
  return {
    fileId: saved.id,
    path: saved.path,
    markdown: `![${alt}](${saved.path})`,
  };
};

/**
 * Rebuild the file references of a page from its content. Called after
 * every content write (create, update, block sync, string edit).
 *
 *   - added references: file expiry is cleared (kept permanently)
 *   - removed references: if no OTHER page references the file anymore,
 *     it gets a grace-period expiry for the cleanup cron
 */
export const syncKnowledgeTextFileReferences = async (page: {
  id: string;
  tenantId: string;
  text: string;
}): Promise<{ added: number; removed: number }> => {
  const db = getDb();
  const referencedIds = extractKnowledgeFileIds(page.text);

  // only accept files that really exist in this tenant's knowledge bucket
  const validFiles =
    referencedIds.length > 0
      ? await db
          .select({ id: files.id })
          .from(files)
          .where(
            and(
              inArray(files.id, referencedIds),
              eq(files.tenantId, page.tenantId),
              eq(files.bucket, KNOWLEDGE_FILES_BUCKET)
            )
          )
      : [];
  const validIds = new Set(validFiles.map((f) => f.id));

  const currentRefs = await db
    .select({ fileId: knowledgeTextFile.fileId })
    .from(knowledgeTextFile)
    .where(eq(knowledgeTextFile.knowledgeTextId, page.id));
  const currentIds = new Set(currentRefs.map((r) => r.fileId));

  const toAdd = [...validIds].filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !validIds.has(id));

  if (toAdd.length > 0) {
    await db.insert(knowledgeTextFile).values(
      toAdd.map((fileId) => ({
        tenantId: page.tenantId,
        knowledgeTextId: page.id,
        fileId,
      }))
    );
    // referenced files are permanent
    await db
      .update(files)
      .set({ expiresAt: null })
      .where(inArray(files.id, toAdd));
  }

  if (toRemove.length > 0) {
    await db
      .delete(knowledgeTextFile)
      .where(
        and(
          eq(knowledgeTextFile.knowledgeTextId, page.id),
          inArray(knowledgeTextFile.fileId, toRemove)
        )
      );
    await expireFilesWithoutReferences(toRemove);
  }

  return { added: toAdd.length, removed: toRemove.length };
};

/**
 * Give every file from `fileIds` that has no remaining page reference a
 * grace-period expiry. Files still referenced elsewhere are left alone.
 */
const expireFilesWithoutReferences = async (fileIds: string[]) => {
  if (fileIds.length === 0) return;
  const db = getDb();
  const stillReferenced = await db
    .select({ fileId: knowledgeTextFile.fileId })
    .from(knowledgeTextFile)
    .where(inArray(knowledgeTextFile.fileId, fileIds));
  const keep = new Set(stillReferenced.map((r) => r.fileId));
  const orphaned = fileIds.filter((id) => !keep.has(id));
  if (orphaned.length > 0) {
    await db
      .update(files)
      .set({ expiresAt: hoursFromNow(ORPHANED_FILE_GRACE_DAYS * 24) })
      .where(inArray(files.id, orphaned));
  }
};

/**
 * Called BEFORE a page is deleted: files exclusively referenced by this
 * page get the grace-period expiry (the reference rows themselves vanish
 * with the page via FK cascade).
 */
export const markKnowledgeTextFilesForCleanup = async (
  knowledgeTextId: string
): Promise<void> => {
  const db = getDb();
  const refs = await db
    .select({ fileId: knowledgeTextFile.fileId })
    .from(knowledgeTextFile)
    .where(eq(knowledgeTextFile.knowledgeTextId, knowledgeTextId));
  if (refs.length === 0) return;

  // drop this page's references first, then expire whatever is orphaned
  await db
    .delete(knowledgeTextFile)
    .where(eq(knowledgeTextFile.knowledgeTextId, knowledgeTextId));
  await expireFilesWithoutReferences(refs.map((r) => r.fileId));
};

/**
 * Delete every file whose expiry has passed — the backing job for the
 * weekly cleanup cron. Index-only (files_expires_at_idx) and generic: any
 * bucket that uses `expiresAt` benefits.
 */
export const cleanupExpiredFiles = async (): Promise<{ deleted: number }> => {
  const deleted = await getDb()
    .delete(files)
    .where(
      and(isNotNull(files.expiresAt), lt(files.expiresAt, sql`now()`))
    )
    .returning({ id: files.id });
  if (deleted.length > 0) {
    log.info(`File cleanup: removed ${deleted.length} expired file(s)`);
  }
  return { deleted: deleted.length };
};
