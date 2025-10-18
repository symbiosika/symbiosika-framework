import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { defineFilesRoutes } from ".";
import type { FastAppHono } from "../../../../types";
import { initTests, TEST_ORGANISATION_1 } from "../../../../test/init.test";

describe("Files API Endpoints", () => {
  const app: FastAppHono = new Hono();
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
      "/api/organisation/" + TEST_ORGANISATION_1.id + "/files/db/" + testBucket,
      {
        method: "POST",
        body: formData,
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(dbResponse.status).toBe(200);
    const dbData = await dbResponse.json();
    expect(dbData.id).toBeDefined();
    dbFileId = dbData.id;

    // Test local upload
    const localResponse = await app.request(
      "/api/organisation/" +
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
    const localData = await localResponse.json();
    expect(localData.id).toBeDefined();
    localFileId = localData.id;
  });

  // Test file retrieval
  it("should retrieve uploaded files", async () => {
    // Test DB retrieval
    const dbResponse = await app.request(
      `/api/organisation/${TEST_ORGANISATION_1.id}/files/db/${testBucket}/${dbFileId}`,
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
      `/api/organisation/${TEST_ORGANISATION_1.id}/files/local/${testBucket}/${localFileId}.txt`,
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
      `/api/organisation/${TEST_ORGANISATION_1.id}/files/db/${testBucket}/${dbFileId}`,
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
      `/api/organisation/${TEST_ORGANISATION_1.id}/files/local/${testBucket}/${localFileId}.txt`,
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
      `/api/organisation/${TEST_ORGANISATION_1.id}/files/db/${testBucket}/${dbFileId}`,
      {
        method: "GET",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );
    expect(dbGetResponse.status).toBe(400);

    const localGetResponse = await app.request(
      `/api/organisation/${TEST_ORGANISATION_1.id}/files/local/${testBucket}/${localFileId}.txt`,
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
      "/api/organisation/" +
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
      "/api/organisation/" + TEST_ORGANISATION_1.id + "/files/db/" + testBucket,
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
});
