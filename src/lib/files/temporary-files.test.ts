import { describe, it, expect } from "bun:test";
import {
  saveFileToTemporaryStorage,
  removeTemporaryFile,
} from "./temporary-files";
import fs from "fs/promises";

describe("Temporary Files", () => {
  it("should save file to temporary storage", async () => {
    // Create a mock File object
    const testContent = "test content";
    const blob = new Blob([testContent], { type: "text/plain" });
    const file = new File([blob], "test.txt", { type: "text/plain" });

    // Save the file
    const { path, filename } = await saveFileToTemporaryStorage(file);

    // Verify the file exists and content is correct
    const exists = await fs
      .access(path)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(path, "utf-8");
    expect(content).toBe(testContent);

    // Cleanup
    await removeTemporaryFile(path);
  });

  it("should remove temporary file", async () => {
    // Create a test file first
    const testContent = "test content";
    const blob = new Blob([testContent], { type: "text/plain" });
    const file = new File([blob], "test.txt", { type: "text/plain" });

    const { path } = await saveFileToTemporaryStorage(file);

    // Remove the file
    await removeTemporaryFile(path);

    // Verify the file doesn't exist
    const exists = await fs
      .access(path)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("should generate unique filenames for each save", async () => {
    const file1 = new File([new Blob(["content"])], "test.txt");
    const file2 = new File([new Blob(["content"])], "test.txt");

    const result1 = await saveFileToTemporaryStorage(file1);
    const result2 = await saveFileToTemporaryStorage(file2);

    expect(result1.filename).not.toBe(result2.filename);

    // Cleanup
    await removeTemporaryFile(result1.path);
    await removeTemporaryFile(result2.path);
  });
});
