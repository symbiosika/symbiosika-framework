import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { saveFile, getFile, deleteFile } from "./index";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import fs from "fs/promises";
import path from "path";

// Mock test data
const testFile = new File(["test content"], "test.txt", { type: "text/plain" });
const testBucket = "test-bucket";
const ATTACHMENT_DIR = path.join(process.cwd(), "static/upload");

// Helper to clean up test files
const cleanupTestFiles = async () => {
  try {
    await fs.rm(path.join(ATTACHMENT_DIR, testBucket), {
      recursive: true,
      force: true,
    });
  } catch (error) {
    // Ignore errors if directory doesn't exist
  }
};

beforeAll(async () => {
  await initTests();
});

afterAll(async () => {
  await cleanupTestFiles();
});

beforeEach(async () => {
  await cleanupTestFiles();
});

describe("Storage Functions", () => {
  describe("Local Storage", () => {
    test("should save and get file from local storage", async () => {
      const saveResult = await saveFile(
        testFile,
        testBucket,
        TEST_ORGANISATION_1.id,
        "local"
      );
      expect(saveResult).toBeDefined();
      expect(saveResult.name).toBe("test.txt");

      // Extract file ID from path
      const fileId = path.basename(saveResult.path);
      const file = await getFile(
        fileId,
        testBucket,
        TEST_ORGANISATION_1.id,
        "local"
      );
      expect(file).toBeDefined();

      const content = await file.text();
      expect(content).toBe("test content");
    });

    test("should delete file from local storage", async () => {
      const saveResult = await saveFile(
        testFile,
        testBucket,
        TEST_ORGANISATION_1.id,
        "local"
      );
      const filePath = saveResult.path;
      const fileName = filePath.split("/").pop() || "";

      await deleteFile(fileName, testBucket, TEST_ORGANISATION_1.id, "local");

      // Verify file is deleted
      await expect(
        getFile(fileName, testBucket, TEST_ORGANISATION_1.id, "local")
      ).rejects.toThrow("File not found");
    });

    test("should throw error when getting non-existent file", async () => {
      await expect(
        getFile("nonexistent.txt", testBucket, TEST_ORGANISATION_1.id, "local")
      ).rejects.toThrow("File not found");
    });
  });

  describe("DB Storage", () => {
    test("should save and get file from database", async () => {
      const saveResult = await saveFile(
        testFile,
        testBucket,
        TEST_ORGANISATION_1.id,
        "db"
      );
      expect(saveResult).toBeDefined();
      expect(saveResult.name).toBe("test.txt");

      const file = await getFile(
        saveResult.id,
        testBucket,
        TEST_ORGANISATION_1.id,
        "db"
      );
      expect(file).toBeDefined();

      const content = await file.text();
      expect(content).toBe("test content");
    });

    test("should delete file from database", async () => {
      const saveResult = await saveFile(
        testFile,
        testBucket,
        TEST_ORGANISATION_1.id,
        "db"
      );

      await deleteFile(saveResult.id, testBucket, TEST_ORGANISATION_1.id, "db");

      // Verify file is deleted by checking that get throws an error
      try {
        await getFile(saveResult.id, testBucket, TEST_ORGANISATION_1.id, "db");
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    test("should throw error when getting non-existent file", async () => {
      await expect(
        getFile("nonexistent", testBucket, TEST_ORGANISATION_1.id, "db")
      ).rejects.toThrow("Failed to get file from database");
    });
  });

  describe("Invalid Storage Type", () => {
    test("should throw error for invalid storage type on save", async () => {
      await expect(
        saveFile(testFile, testBucket, TEST_ORGANISATION_1.id, "invalid" as any)
      ).rejects.toThrow("Invalid storage type");
    });

    test("should throw error for invalid storage type on get", async () => {
      await expect(
        getFile(
          "test.txt",
          testBucket,
          TEST_ORGANISATION_1.id,
          "invalid" as any
        )
      ).rejects.toThrow("Invalid storage type");
    });

    test("should throw error for invalid storage type on delete", async () => {
      await expect(
        deleteFile(
          "test.txt",
          testBucket,
          TEST_ORGANISATION_1.id,
          "invalid" as any
        )
      ).rejects.toThrow("Invalid storage type");
    });
  });
});
