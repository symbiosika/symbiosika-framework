/**
 * Temporary URLs for stored files.
 *
 *   bun run test:local src/lib/storage/share.test.ts
 *
 * What matters here is what a share grants and for how long: one file, never
 * another, never for ever, and never usable as a session. The object store is
 * exercised against the same stand-in the s3 backend's own tests use, so a
 * presigned URL is seen to be built without a service.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import jwt from "jsonwebtoken";
import { getFile, saveFile } from "./index";
import {
  createFileShareToken,
  DEFAULT_SHARE_TTL_SECONDS,
  MAX_SHARE_TTL_SECONDS,
  shareFile,
  SHARE_TOKEN_PURPOSE,
  verifyFileShareToken,
} from "./share";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

const BUCKET = "share-test";
const T = TEST_ORGANISATION_1.id;

const savedEnv: Record<string, string | undefined> = {};
const setEnv = (key: string, value: string | undefined) => {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

let originalBaseUrl = "";

beforeAll(async () => {
  await initTests();
  originalBaseUrl = _GLOBAL_SERVER_CONFIG.baseUrl;
  _GLOBAL_SERVER_CONFIG.baseUrl = "https://app.example.com";
});

afterAll(() => {
  _GLOBAL_SERVER_CONFIG.baseUrl = originalBaseUrl;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the share token", () => {
  const ref = {
    tenantId: T,
    bucket: BUCKET,
    name: "abc.txt",
    storageType: "db" as const,
  };

  it("names exactly one file and survives a round trip", () => {
    const token = createFileShareToken(ref, 60);
    expect(verifyFileShareToken(token)).toEqual(ref);
  });

  it("is refused once it has expired", async () => {
    const token = jwt.sign(
      { ...ref, purpose: SHARE_TOKEN_PURPOSE },
      process.env.JWT_PRIVATE_KEY || "",
      { expiresIn: -1 }
    );
    expect(() => verifyFileShareToken(token)).toThrow();
  });

  it("is not a session token, and a session token is not a share", () => {
    // same key, no purpose: must not open a file
    const lookalike = jwt.sign(
      { ...ref, usersId: "someone" },
      process.env.JWT_PRIVATE_KEY || "",
      { expiresIn: 600 }
    );
    expect(() => verifyFileShareToken(lookalike)).toThrow("Invalid file share token");
    // and a share carries its own purpose, so it cannot pass as a session
    const share = jwt.decode(createFileShareToken(ref, 60)) as Record<string, unknown>;
    expect(share.purpose).toBe(SHARE_TOKEN_PURPOSE);
    expect(share.usersId).toBeUndefined();
  });

  it("is refused when it was signed with another key", () => {
    const foreign = jwt.sign({ ...ref, purpose: SHARE_TOKEN_PURPOSE }, "not-the-key", {
      expiresIn: 600,
    });
    expect(() => verifyFileShareToken(foreign)).toThrow();
  });

  it("is refused when it names nothing", () => {
    const empty = jwt.sign({ purpose: SHARE_TOKEN_PURPOSE }, process.env.JWT_PRIVATE_KEY || "", {
      expiresIn: 600,
    });
    expect(() => verifyFileShareToken(empty)).toThrow("Invalid file share token");
  });
});

describe("shareFile", () => {
  it("gives a link of this server for a file in the database, and it opens that file", async () => {
    const saved = await saveFile(
      new File(["shared content"], "note.txt", { type: "text/plain" }),
      BUCKET,
      T,
      "db"
    );
    const share = await shareFile(saved.id, BUCKET, T, "db");

    expect(share.url.startsWith("https://app.example.com/api/v1/files/shared/")).toBe(true);
    expect(share.expiresIn).toBe(DEFAULT_SHARE_TTL_SECONDS);
    expect(new Date(share.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // the token names that one file and nothing else
    const token = share.url.split("/").pop()!;
    const ref = verifyFileShareToken(token);
    expect(ref).toEqual({ tenantId: T, bucket: BUCKET, name: saved.id, storageType: "db" });
    expect(await (await getFile(ref.name, ref.bucket, ref.tenantId, ref.storageType)).text()).toBe(
      "shared content"
    );
  });

  it("bounds the time, whatever is asked for", async () => {
    const saved = await saveFile(new File(["x"], "x.txt"), BUCKET, T, "db");
    expect((await shareFile(saved.id, BUCKET, T, "db", { expiresInSeconds: 60 })).expiresIn).toBe(60);
    // a week is not a share
    expect(
      (await shareFile(saved.id, BUCKET, T, "db", { expiresInSeconds: 7 * 24 * 3600 })).expiresIn
    ).toBe(MAX_SHARE_TTL_SECONDS);
    // nonsense falls back to the default instead of granting for ever
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await shareFile(saved.id, BUCKET, T, "db", { expiresInSeconds: bad })).expiresIn).toBe(
        DEFAULT_SHARE_TTL_SECONDS
      );
    }
  });

  it("gives a presigned URL of the object store for s3, which never touches this server", async () => {
    setEnv("S3_BUCKET", "files");
    setEnv("S3_ENDPOINT", "http://127.0.0.1:9999");
    setEnv("S3_REGION", "us-east-1");
    setEnv("S3_ACCESS_KEY_ID", "test-key");
    setEnv("S3_SECRET_ACCESS_KEY", "test-secret");

    const share = await shareFile("abcdef.zip", BUCKET, T, "s3", { expiresInSeconds: 120 });

    expect(share.url.startsWith("http://127.0.0.1:9999/files/")).toBe(true);
    expect(share.url).toContain(`${T}/${BUCKET}/abcdef.zip`);
    expect(share.url).toContain("X-Amz-Signature=");
    expect(share.url).toContain("X-Amz-Expires=120");
    expect(share.expiresIn).toBe(120);
    // nothing of this installation's own token is in it
    expect(share.url).not.toContain(SHARE_TOKEN_PURPOSE);

    for (const key of [
      "S3_BUCKET",
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ]) {
      setEnv(key, undefined);
    }
  });

  it("refuses a storage type it does not know", async () => {
    await expect(shareFile("a.txt", BUCKET, T, "azure" as never)).rejects.toThrow(
      "Invalid storage type"
    );
  });
});
