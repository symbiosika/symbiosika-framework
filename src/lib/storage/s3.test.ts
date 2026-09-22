/**
 * The S3 backend, against a stand-in object store.
 *
 *   bun test src/lib/storage/s3.test.ts
 *
 * A real S3 service is not needed and not wanted in a test run, so these tests
 * point S3_ENDPOINT at a small HTTP server that keeps objects in a Map and
 * answers PUT, GET and DELETE the way an S3-compatible service does. That is
 * enough to see the whole backend work: the key that is built, the round trip
 * of the bytes, the content type, the 404 and the delete. The signature Bun
 * puts on the request is not checked by the stand-in; what is tested here is
 * this backend, not AWS.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  deleteFile,
  getFile,
  isStorageType,
  saveFile,
  STORAGE_TYPES,
} from "./index";
import {
  assertS3Configured,
  deleteFileFromS3,
  getFileFromS3,
  s3Config,
  s3Key,
  saveFileToS3,
} from "./s3";

const BUCKET = "test-bucket";
const TENANT = "00000000-1111-2222-3333-444444444444";

/** The objects the stand-in holds, by the path of the request. */
const objects = new Map<string, { body: Uint8Array; type: string }>();

let server: ReturnType<typeof Bun.serve>;
const savedEnv: Record<string, string | undefined> = {};

const setEnv = (key: string, value: string | undefined) => {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const key = new URL(request.url).pathname;
      if (request.method === "PUT") {
        objects.set(key, {
          body: new Uint8Array(await request.arrayBuffer()),
          type: request.headers.get("content-type") ?? "",
        });
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const object = objects.get(key);
        if (!object) return new Response("NoSuchKey", { status: 404 });
        return new Response(request.method === "HEAD" ? null : object.body, {
          status: 200,
          headers: { "content-type": object.type || "application/octet-stream" },
        });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    },
  });

  setEnv("S3_BUCKET", "files");
  setEnv("S3_ENDPOINT", `http://127.0.0.1:${server.port}`);
  setEnv("S3_REGION", "us-east-1");
  setEnv("S3_ACCESS_KEY_ID", "test-key");
  setEnv("S3_SECRET_ACCESS_KEY", "test-secret");
  setEnv("S3_PREFIX", undefined);
  setEnv("S3_VIRTUAL_HOSTED_STYLE", undefined);
});

afterEach(() => {
  setEnv("S3_PREFIX", undefined);
});

afterAll(() => {
  server.stop(true);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("s3 configuration", () => {
  it("refuses to work without a bucket, and says so at start-up", () => {
    setEnv("S3_BUCKET", undefined);
    expect(() => assertS3Configured()).toThrow(/S3_BUCKET/);
    setEnv("S3_BUCKET", "files");
    expect(() => assertS3Configured()).not.toThrow();
  });

  it('reads the prefix in every spelling and keeps it as "x/"', () => {
    setEnv("S3_PREFIX", "app");
    expect(s3Config().prefix).toBe("app/");
    setEnv("S3_PREFIX", "/app/");
    expect(s3Config().prefix).toBe("app/");
    setEnv("S3_PREFIX", "  ");
    expect(s3Config().prefix).toBe("");
    setEnv("S3_PREFIX", undefined);
    expect(s3Config().prefix).toBe("");
  });
});

describe("s3 keys", () => {
  it("puts the tenant into the key, under the prefix", () => {
    expect(s3Key(TENANT, BUCKET, "a.png")).toBe(`${TENANT}/${BUCKET}/a.png`);
    setEnv("S3_PREFIX", "app");
    expect(s3Key(TENANT, BUCKET, "a.png")).toBe(
      `app/${TENANT}/${BUCKET}/a.png`
    );
  });

  it("refuses anything that would leave the prefix or reach another tenant", () => {
    const traversal = [
      "../secret",
      "..",
      ".",
      "../../etc/passwd",
      "foo/bar",
      "foo\\bar",
      "with\0null",
      "/etc/passwd",
      "",
    ];
    for (const bad of traversal) {
      expect(() => s3Key(TENANT, BUCKET, bad)).toThrow();
      expect(() => s3Key(TENANT, bad, "a.png")).toThrow();
      expect(() => s3Key(bad, BUCKET, "a.png")).toThrow();
    }
  });
});

describe("s3 storage", () => {
  it("saves, reads back and deletes a file", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "scene.png", {
      type: "image/png",
    });
    const saved = await saveFileToS3(file, BUCKET, TENANT);

    expect(saved.name).toBe("scene.png");
    expect(saved.tenantId).toBe(TENANT);
    // the id is server-generated, the path names the backend and the stored name
    expect(saved.path).toBe(
      `/api/v1/tenant/${TENANT}/files/s3/${BUCKET}/${saved.id}.png`
    );
    // the object lies under the tenant, so another tenant cannot address it
    expect([...objects.keys()]).toContain(
      `/files/${TENANT}/${BUCKET}/${saved.id}.png`
    );

    const storedName = saved.path.split("/").pop()!;
    const read = await getFileFromS3(storedName, BUCKET, TENANT);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
    expect(read.type).toBe("image/png");

    await deleteFileFromS3(storedName, BUCKET, TENANT);
    expect(
      objects.has(`/files/${TENANT}/${BUCKET}/${saved.id}.png`)
    ).toBe(false);
  });

  it("stores a file without an extension too", async () => {
    const saved = await saveFileToS3(
      new File(["plain"], "noextension"),
      BUCKET,
      TENANT
    );
    expect(saved.path.endsWith(saved.id)).toBe(true);
    const read = await getFileFromS3(saved.id, BUCKET, TENANT);
    expect(await read.text()).toBe("plain");
    await deleteFileFromS3(saved.id, BUCKET, TENANT);
  });

  it("keeps the files of two tenants apart", async () => {
    const other = "00000000-1111-2222-3333-555555555555";
    const mine = await saveFileToS3(
      new File(["mine"], "a.txt", { type: "text/plain" }),
      BUCKET,
      TENANT
    );
    const name = mine.path.split("/").pop()!;
    // the same name under another tenant is another object, and there is none
    await expect(getFileFromS3(name, BUCKET, other)).rejects.toThrow(
      "File not found"
    );
    expect(await (await getFileFromS3(name, BUCKET, TENANT)).text()).toBe(
      "mine"
    );
    await deleteFileFromS3(name, BUCKET, TENANT);
  });

  it("says the file is not there instead of handing back an error page", async () => {
    await expect(
      getFileFromS3("11111111-2222-3333-4444-555555555555.png", BUCKET, TENANT)
    ).rejects.toThrow("File not found");
  });
});

describe("the generic storage functions", () => {
  it('dispatches storageType "s3" to this backend', async () => {
    const saved = await saveFile(
      new File(["through the dispatcher"], "note.txt", { type: "text/plain" }),
      BUCKET,
      TENANT,
      "s3"
    );
    expect(saved.name).toBe("note.txt");
    const storedName = saved.path.split("/").pop()!;

    const read = await getFile(storedName, BUCKET, TENANT, "s3");
    expect(await read.text()).toBe("through the dispatcher");
    expect(read.type).toContain("text/plain");

    await deleteFile(storedName, BUCKET, TENANT, "s3");
    await expect(getFile(storedName, BUCKET, TENANT, "s3")).rejects.toThrow(
      "File not found"
    );
  });

  it("knows which storage types it carries", () => {
    expect(STORAGE_TYPES).toEqual(["db", "local", "s3"]);
    expect(isStorageType("s3")).toBe(true);
    expect(isStorageType("azure")).toBe(false);
    expect(isStorageType(undefined)).toBe(false);
  });
});
