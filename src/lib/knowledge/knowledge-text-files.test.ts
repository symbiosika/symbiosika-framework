import { describe, it, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import {
  uploadKnowledgeTextImage,
  syncKnowledgeTextFileReferences,
  markKnowledgeTextFilesForCleanup,
  cleanupExpiredFiles,
  extractKnowledgeFileIds,
  KNOWLEDGE_FILES_BUCKET,
} from "./knowledge-text-files";
import {
  createKnowledgeText,
  updateKnowledgeText,
  deleteKnowledgeText,
} from "./knowledge-texts";
import { syncKnowledgeTextBlocks } from "./knowledge-text-blocks";
import { getDb } from "../db/db-connection";
import { files } from "../db/schema/files";
import { knowledgeTextFile } from "../db/schema/knowledge";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

// tiny valid PNG (1x1 transparent pixel)
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

const pngFile = (name = "pixel.png") =>
  new File([PNG_BYTES], name, { type: "image/png" });

const createPage = async () =>
  await createKnowledgeText({
    title: `Image Test Page ${crypto.randomUUID()}`,
    text: "",
    tenantId: ctx.tenantId,
  });

const getFileRow = async (fileId: string) => {
  const rows = await getDb()
    .select()
    .from(files)
    .where(eq(files.id, fileId));
  return rows[0] ?? null;
};

const getRefs = async (pageId: string) =>
  await getDb()
    .select()
    .from(knowledgeTextFile)
    .where(eq(knowledgeTextFile.knowledgeTextId, pageId));

describe("extractKnowledgeFileIds", () => {
  it("extracts knowledge file ids from markdown and html", () => {
    const id1 = "0b0e8f0a-1111-4222-8333-444455556666";
    const id2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const ids = extractKnowledgeFileIds(
      `![a](/api/v1/tenant/x/files/db/knowledge/${id1}.png)\n` +
        `<img src="/api/v1/tenant/x/files/db/knowledge/${id2.toUpperCase()}.jpg">` +
        `![other bucket](/api/v1/tenant/x/files/db/avatars/${id1}.png)`
    );
    expect(ids.sort()).toEqual([id1, id2].sort());
  });

  it("returns [] when nothing matches", () => {
    expect(extractKnowledgeFileIds("no images here")).toEqual([]);
  });
});

describe("Knowledge Text Images", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("uploads an image with a short expiry and a markdown snippet", async () => {
    const page = await createPage();
    const upload = await uploadKnowledgeTextImage(page.id, pngFile(), ctx, {
      alt: "my pixel",
    });

    expect(upload.fileId).toBeDefined();
    expect(upload.path).toContain(`/files/db/${KNOWLEDGE_FILES_BUCKET}/`);
    expect(upload.markdown).toBe(`![my pixel](${upload.path})`);

    const row = await getFileRow(upload.fileId);
    expect(row?.bucket).toBe(KNOWLEDGE_FILES_BUCKET);
    // unreferenced upload expires
    expect(row?.expiresAt).not.toBeNull();
  });

  it("rejects non-images and oversized files", async () => {
    const page = await createPage();
    await expect(
      uploadKnowledgeTextImage(
        page.id,
        new File(["text"], "doc.txt", { type: "text/plain" }),
        ctx
      )
    ).rejects.toThrow("Only image uploads");

    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", {
      type: "image/png",
    });
    await expect(
      uploadKnowledgeTextImage(page.id, big, ctx)
    ).rejects.toThrow("maximum size");
  });

  it("saving content with the image makes the file permanent", async () => {
    const page = await createPage();
    const upload = await uploadKnowledgeTextImage(page.id, pngFile(), ctx);

    await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: `Intro\n\n${upload.markdown}` }],
      ctx
    );

    const refs = await getRefs(page.id);
    expect(refs.length).toBe(1);
    expect(refs[0]?.fileId).toBe(upload.fileId);
    // referenced → expiry cleared
    const row = await getFileRow(upload.fileId);
    expect(row?.expiresAt).toBeNull();
  });

  it("removing the image from the content schedules it for cleanup", async () => {
    const page = await createPage();
    const upload = await uploadKnowledgeTextImage(page.id, pngFile(), ctx);

    const saved = await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: upload.markdown }],
      ctx
    );
    expect((await getFileRow(upload.fileId))?.expiresAt).toBeNull();

    // editor deletes the image block
    await syncKnowledgeTextBlocks(
      page.id,
      [
        {
          id: saved.blocks[0]!.id,
          type: "markdown",
          content: "image removed",
        },
      ],
      ctx
    );

    expect((await getRefs(page.id)).length).toBe(0);
    // grace-period expiry set
    expect((await getFileRow(upload.fileId))?.expiresAt).not.toBeNull();

    // undo: re-adding the image rescues it
    await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: upload.markdown }],
      ctx
    );
    expect((await getFileRow(upload.fileId))?.expiresAt).toBeNull();
  });

  it("keeps a file alive while ANOTHER page still references it", async () => {
    const pageA = await createPage();
    const pageB = await createPage();
    const upload = await uploadKnowledgeTextImage(pageA.id, pngFile(), ctx);

    await updateKnowledgeText(pageA.id, { text: upload.markdown }, ctx);
    await updateKnowledgeText(pageB.id, { text: upload.markdown }, ctx);

    // remove from page A — page B still uses it
    await updateKnowledgeText(pageA.id, { text: "gone" }, ctx);
    expect((await getFileRow(upload.fileId))?.expiresAt).toBeNull();

    // remove from page B too — now it expires
    await updateKnowledgeText(pageB.id, { text: "gone too" }, ctx);
    expect((await getFileRow(upload.fileId))?.expiresAt).not.toBeNull();
  });

  it("deleting a page schedules its exclusive images for cleanup", async () => {
    const page = await createPage();
    const shared = await createPage();
    const exclusive = await uploadKnowledgeTextImage(page.id, pngFile(), ctx);
    const sharedUpload = await uploadKnowledgeTextImage(
      page.id,
      pngFile("shared.png"),
      ctx
    );

    await updateKnowledgeText(
      page.id,
      { text: `${exclusive.markdown}\n${sharedUpload.markdown}` },
      ctx
    );
    await updateKnowledgeText(shared.id, { text: sharedUpload.markdown }, ctx);

    await deleteKnowledgeText(page.id, ctx);

    // exclusive image expires, shared one survives
    expect((await getFileRow(exclusive.fileId))?.expiresAt).not.toBeNull();
    expect((await getFileRow(sharedUpload.fileId))?.expiresAt).toBeNull();
  });

  it("ignores unknown or foreign file ids in the content", async () => {
    const page = await createPage();
    const fakeId = crypto.randomUUID();
    const result = await syncKnowledgeTextFileReferences({
      id: page.id,
      tenantId: ctx.tenantId,
      text: `![ghost](/api/v1/tenant/x/files/db/knowledge/${fakeId}.png)`,
    });
    expect(result.added).toBe(0);
    expect((await getRefs(page.id)).length).toBe(0);
  });

  it("cleanupExpiredFiles removes only expired files", async () => {
    const page = await createPage();
    const expired = await uploadKnowledgeTextImage(page.id, pngFile(), ctx);
    const kept = await uploadKnowledgeTextImage(
      page.id,
      pngFile("kept.png"),
      ctx
    );
    // make one file expired NOW, keep the other referenced
    await getDb()
      .update(files)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(files.id, expired.fileId));
    await updateKnowledgeText(page.id, { text: kept.markdown }, ctx);

    const result = await cleanupExpiredFiles();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    expect(await getFileRow(expired.fileId)).toBeNull();
    expect(await getFileRow(kept.fileId)).not.toBeNull();
  });

  it("markKnowledgeTextFilesForCleanup is a no-op for pages without files", async () => {
    const page = await createPage();
    await markKnowledgeTextFilesForCleanup(page.id);
    expect((await getRefs(page.id)).length).toBe(0);
  });
});
