import { afterAll, describe, expect, it } from "bun:test";
import fs from "fs/promises";
import path from "path";
import {
  getFileFromLocalDisc,
  saveFileToLocalDisc,
  deleteFileFromLocalDisc,
} from "./local";

const ATTACHMENT_DIR = path.join(process.cwd(), "static/upload");

/**
 * These tests exercise the path-traversal hardening: any bucket / file name
 * that could escape the upload directory must be rejected before touching the
 * filesystem.
 */
describe("local storage path traversal protection", () => {
  const traversalNames = [
    "../secret",
    "..",
    "../../etc/passwd",
    "foo/bar",
    "foo\\bar",
    "with\0null",
    "/etc/passwd",
  ];

  it("rejects traversal in getFileFromLocalDisc (bucket and name)", async () => {
    for (const bad of traversalNames) {
      await expect(getFileFromLocalDisc(bad, "bucket", "t1")).rejects.toThrow();
      await expect(getFileFromLocalDisc("file.txt", bad, "t1")).rejects.toThrow();
    }
  });

  it("rejects traversal in deleteFileFromLocalDisc", async () => {
    for (const bad of traversalNames) {
      await expect(
        deleteFileFromLocalDisc(bad, "bucket", "t1")
      ).rejects.toThrow();
      await expect(
        deleteFileFromLocalDisc("file.txt", bad, "t1")
      ).rejects.toThrow();
    }
  });

  it("rejects traversal bucket in saveFileToLocalDisc", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "test.bin");
    for (const bad of traversalNames) {
      await expect(saveFileToLocalDisc(file, bad, "t1")).rejects.toThrow();
    }
  });

  it("accepts a safe bucket and round-trips a file", async () => {
    const bucket = "safe-bucket_1";
    const file = new File([new Uint8Array([4, 5, 6, 7])], "doc.bin");
    const saved = await saveFileToLocalDisc(file, bucket, "t1");
    const publicName = saved.path.split("/").pop()!;
    const fetched = await getFileFromLocalDisc(publicName, bucket, "t1");
    const bytes = new Uint8Array(await fetched.arrayBuffer());
    expect(Array.from(bytes)).toEqual([4, 5, 6, 7]);
    await deleteFileFromLocalDisc(publicName, bucket, "t1");
  });

  afterAll(async () => {
    await fs
      .rm(path.join(ATTACHMENT_DIR, "safe-bucket_1"), {
        recursive: true,
        force: true,
      })
      .catch(() => {});
  });
});
