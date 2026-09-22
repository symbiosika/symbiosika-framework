import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { defineFilesRoutes } from ".";
import type { SymbiosikaFrameworkHonoApp } from "../../../../types";
import { initTests, TEST_ORGANISATION_1 } from "../../../../test/init.test";
import jsonwebtoken from "jsonwebtoken";
import { shareFile } from "../../../../lib/storage/share";

describe("Files API Endpoints", () => {
  const app: SymbiosikaFrameworkHonoApp = new Hono();
  const testBucket = "test-bucket";
  let dbFileId: string;
  let localFileId: string;
  let jwt: string;

  beforeAll(async () => {
    const { user1Token } = await initTests();
    jwt = user1Token;
    defineFilesRoutes(app, "/api");
  });

  // Test file upload for both storage types
  it("should upload files to DB and local storage", async () => {
    const testFile = new File(["test content"], "test.txt", {
      type: "text/plain",
    });
    const formData = new FormData();
    formData.append("file", testFile);

    // Test DB upload
    const dbResponse = await app.request(
      "/api/tenant/" + TEST_ORGANISATION_1.id + "/files/db/" + testBucket,
      {
        method: "POST",
        body: formData,
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(dbResponse.status).toBe(200);
    const dbData: any = await dbResponse.json();
    expect(dbData.id).toBeDefined();
    dbFileId = dbData.id;

    // Test local upload
    const localResponse = await app.request(
      "/api/tenant/" +
        TEST_ORGANISATION_1.id +
        "/files/local/" +
        testBucket,
      {
        method: "POST",
        body: formData,
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(localResponse.status).toBe(200);
    const localData: any = await localResponse.json();
    expect(localData.id).toBeDefined();
    localFileId = localData.id;
  });

  // Test file retrieval
  it("should retrieve uploaded files", async () => {
    // Test DB retrieval
    const dbResponse = await app.request(
      `/api/tenant/${TEST_ORGANISATION_1.id}/files/db/${testBucket}/${dbFileId}`,
      {
        method: "GET",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(dbResponse.status).toBe(200);
    const dbContent = await dbResponse.text();
    expect(dbContent).toBe("test content");

    // Test local retrieval
    const localResponse = await app.request(
      `/api/tenant/${TEST_ORGANISATION_1.id}/files/local/${testBucket}/${localFileId}.txt`,
      {
        method: "GET",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(localResponse.status).toBe(200);
    const localContent = await localResponse.text();
    expect(localContent).toBe("test content");
  });

  // Test file deletion
  it("should delete uploaded files", async () => {
    // Test DB deletion
    const dbResponse = await app.request(
      `/api/tenant/${TEST_ORGANISATION_1.id}/files/db/${testBucket}/${dbFileId}`,
      {
        method: "DELETE",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(dbResponse.status).toBe(204);

    // Test local deletion
    const localResponse = await app.request(
      `/api/tenant/${TEST_ORGANISATION_1.id}/files/local/${testBucket}/${localFileId}.txt`,
      {
        method: "DELETE",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(localResponse.status).toBe(204);

    // Verify files are deleted by trying to retrieve them
    const dbGetResponse = await app.request(
      `/api/tenant/${TEST_ORGANISATION_1.id}/files/db/${testBucket}/${dbFileId}`,
      {
        method: "GET",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(dbGetResponse.status).toBe(400);

    const localGetResponse = await app.request(
      `/api/tenant/${TEST_ORGANISATION_1.id}/files/local/${testBucket}/${localFileId}.txt`,
      {
        method: "GET",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(localGetResponse.status).toBe(400);
  });

  // Test error cases
  it("should handle invalid requests", async () => {
    // Test invalid storage type
    const invalidTypeResponse = await app.request(
      "/api/tenant/" +
        TEST_ORGANISATION_1.id +
        "/files/invalid/" +
        testBucket,
      {
        method: "POST",
        body: new FormData(),
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(invalidTypeResponse.status).toBe(400);

    // Test invalid content type
    const invalidContentResponse = await app.request(
      "/api/tenant/" + TEST_ORGANISATION_1.id + "/files/db/" + testBucket,
      {
        method: "POST",
        body: "invalid",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(invalidContentResponse.status).toBe(400);
  });

  // The share route: the token is the permission, so these requests carry no
  // session at all. That is the point of it.
  it("serves a shared file to a request with no session, and refuses everything else", async () => {
    const upload = await app.request(
      "/api/tenant/" + TEST_ORGANISATION_1.id + "/files/db/" + testBucket,
      {
        method: "POST",
        body: (() => {
          const form = new FormData();
          form.append("file", new File(["shared bytes"], "shared.txt", { type: "text/plain" }));
          return form;
        })(),
        headers: { Cookie: `jwt=${jwt}` },
      }
    );
    expect(upload.status).toBe(200);
    const uploaded: any = await upload.json();

    const share = await shareFile(uploaded.id, testBucket, TEST_ORGANISATION_1.id, "db", {
      expiresInSeconds: 120,
    });
    const token = share.url.split("/").pop()!;

    // no cookie, no bearer: the link carries its own permission
    const served = await app.request(`/api/files/shared/${token}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("shared bytes");
    expect(served.headers.get("cache-control")).toBe("private, no-store");

    // expired
    const expired = signShare(uploaded.id, -1);
    expect((await app.request(`/api/files/shared/${expired}`)).status).toBe(403);

    // signed with another key
    const forged = jsonwebtoken.sign(
      {
        tenantId: TEST_ORGANISATION_1.id,
        bucket: testBucket,
        name: uploaded.id,
        storageType: "db",
        purpose: "file_share",
      },
      "not-the-key",
      { expiresIn: 600 }
    );
    expect((await app.request(`/api/files/shared/${forged}`)).status).toBe(403);

    // a session token is not a share
    expect((await app.request(`/api/files/shared/${jwt}`)).status).toBe(403);

    // nonsense
    expect((await app.request("/api/files/shared/not-a-token")).status).toBe(403);

    // a valid token whose file is gone
    const missing = signShare("11111111-2222-3333-4444-555555555555", 120);
    expect((await app.request(`/api/files/shared/${missing}`)).status).toBe(404);
  });
});

/** A share token for a file of the test organisation, signed the way the framework does. */
const signShare = (name: string, expiresIn: number) =>
  jsonwebtoken.sign(
    {
      tenantId: TEST_ORGANISATION_1.id,
      bucket: "test-bucket",
      name,
      storageType: "db",
      purpose: "file_share",
    },
    process.env.JWT_PRIVATE_KEY || "",
    { expiresIn }
  );
