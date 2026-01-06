import { describe, it, expect, beforeAll } from "bun:test";
import {
  createKnowledgeText,
  getKnowledgeText,
  getKnowledgeTextById,
  getKnowledgeTextHistory,
  updateKnowledgeText,
  deleteKnowledgeText,
} from "./knowledge-texts";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

describe("Knowledge Texts Test", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("should create a new knowledge text entry", async () => {
    const newText = {
      text: "Test knowledge text",
      title: "Test Title",
      tenantId: TEST_ORGANISATION_1.id,
    };

    const createdText = await createKnowledgeText(newText);
    expect(createdText).toHaveProperty("id");
    expect(createdText.text).toBe(newText.text);
    expect(createdText.title).toBe(newText.title);
  });

  it("should read knowledge text list WITHOUT text content", async () => {
    const newText = {
      text: "Another test knowledge text",
      title: "Another Test Title",
      tenantId: TEST_ORGANISATION_1.id,
    };

    await createKnowledgeText(newText);
    const listResult = await getKnowledgeText({
      tenantId: TEST_ORGANISATION_1.id,
    });

    expect(listResult.length).toBeGreaterThan(0);
    // Text should NOT be in list result
    // @ts-ignore
    expect(listResult[0]?.text).toBeUndefined();
    expect(listResult[0]?.title).toBeDefined();
  });

  it("should read single knowledge text entry by ID WITH full content", async () => {
    const newText = {
      text: "Full content test",
      title: "Full Content Title",
      tenantId: TEST_ORGANISATION_1.id,
    };

    const createdText = await createKnowledgeText(newText);
    const readText = await getKnowledgeTextById(createdText.id, {
      tenantId: createdText.tenantId,
    });

    expect(readText.text).toBe(newText.text);
    expect(readText.title).toBe(newText.title);
  });

  it("should update a knowledge text entry", async () => {
    const newText = {
      text: "Text to be updated",
      title: "Title to be updated",
      tenantId: TEST_ORGANISATION_1.id,
    };

    const createdText = await createKnowledgeText(newText);
    const updatedText = await updateKnowledgeText(
      createdText.id,
      {
        text: "Updated text",
        title: "Updated title",
        tenantId: createdText.tenantId,
      },
      {
        tenantId: createdText.tenantId,
      }
    );

    expect(updatedText.text).toBe("Updated text");
    expect(updatedText.title).toBe("Updated title");
  });

  it("should delete a knowledge text entry", async () => {
    const newText = {
      text: "Text to be deleted",
      title: "Title to be deleted",
      tenantId: TEST_ORGANISATION_1.id,
    };

    const createdText = await createKnowledgeText(newText);
    const deletedText = await deleteKnowledgeText(createdText.id, {
      tenantId: createdText.tenantId,
    });

    expect(deletedText.success).toBe(true);
  });

  it("should create a knowledge text with version, hidden and parentId attributes", async () => {
    const parentText = {
      text: "Parent knowledge text",
      title: "Parent Title",
      tenantId: TEST_ORGANISATION_1.id,
      version: 1,
      hidden: false,
    };

    const createdParent = await createKnowledgeText(parentText);
    expect(createdParent).toHaveProperty("id");
    expect(createdParent.version).toBe(1);
    expect(createdParent.hidden).toBe(false);
    expect(createdParent.parentId).toBeNull();

    const childText = {
      text: "Child knowledge text",
      title: "Child Title",
      tenantId: TEST_ORGANISATION_1.id,
      parentId: createdParent.id,
      version: 2,
      hidden: true,
    };

    const createdChild = await createKnowledgeText(childText);
    expect(createdChild).toHaveProperty("id");
    expect(createdChild.parentId).toBe(createdParent.id);
    expect(createdChild.version).toBe(2);
    expect(createdChild.hidden).toBe(true);
  });

  it("should create new version with incremented version and custom hidden", async () => {
    const newText = {
      text: "Text to be versioned",
      title: "Version Test",
      tenantId: TEST_ORGANISATION_1.id,
      version: 1,
      hidden: false,
    };

    const createdText = await createKnowledgeText(newText);
    const updatedText = await updateKnowledgeText(
      createdText.id,
      {
        version: 2, // Will be incremented to 3 (2+1)
        hidden: true,
      },
      {
        tenantId: createdText.tenantId,
      }
    );

    expect(updatedText.version).toBe(3); // 2+1 due to auto-increment
    expect(updatedText.hidden).toBe(true);
    expect(updatedText.id).not.toBe(createdText.id); // New version has new ID
  });

  it("should create a new version instead of overwriting on update", async () => {
    const originalText = {
      text: "Original text content",
      title: "Original Title",
      tenantId: TEST_ORGANISATION_1.id,
      version: 1,
      hidden: false,
    };

    const created = await createKnowledgeText(originalText);
    const originalId = created.id;

    // Update the text
    const updated = await updateKnowledgeText(
      originalId,
      {
        text: "Updated text content",
        title: "Updated Title",
      },
      {
        tenantId: created.tenantId,
      }
    );

    // New version should have incremented version number
    expect(updated.version).toBe(2);
    expect(updated.text).toBe("Updated text content");
    expect(updated.title).toBe("Updated Title");
    expect(updated.hidden).toBe(false);
    expect(updated.id).not.toBe(originalId); // New ID
    expect(updated.parentId).toBe(originalId); // Links to original

    // Original should be marked as hidden - check via getKnowledgeTextById with versionId
    const originalCheck = await getKnowledgeTextById(originalId, {
      tenantId: created.tenantId,
      versionId: originalId, // Get specific old version
    });
    expect(originalCheck).toBeDefined();
    expect(originalCheck.hidden).toBe(true);
  });

  it("should preserve parentId chain across multiple updates", async () => {
    const v1 = await createKnowledgeText({
      text: "Version 1",
      title: "Chain Test",
      tenantId: TEST_ORGANISATION_1.id,
      version: 1,
    });

    const v2 = await updateKnowledgeText(
      v1.id,
      { text: "Version 2" },
      { tenantId: v1.tenantId }
    );
    expect(v2.version).toBe(2);
    expect(v2.parentId).toBe(v1.id);

    const v3 = await updateKnowledgeText(
      v2.id,
      { text: "Version 3" },
      { tenantId: v2.tenantId }
    );
    expect(v3.version).toBe(3);
    expect(v3.parentId).toBe(v1.id); // Points to original, not v2

    // Check all versions using versionId
    const v1Check = await getKnowledgeTextById(v1.id, {
      tenantId: v1.tenantId,
      versionId: v1.id,
    });
    expect(v1Check.hidden).toBe(true);

    const v2Check = await getKnowledgeTextById(v2.id, {
      tenantId: v2.tenantId,
      versionId: v2.id,
    });
    expect(v2Check.hidden).toBe(true);

    // Get latest version - should be v3
    const latestCheck = await getKnowledgeTextById(v1.id, {
      tenantId: v3.tenantId,
    });
    expect(latestCheck.id).toBe(v3.id);
    expect(latestCheck.hidden).toBe(false); // Latest version is visible
  });

  it("should only update specified fields in new version", async () => {
    const original = await createKnowledgeText({
      text: "Original text",
      title: "Original Title",
      tenantId: TEST_ORGANISATION_1.id,
      version: 1,
    });

    // Update only the text, keep title
    const updated = await updateKnowledgeText(
      original.id,
      { text: "Updated text only" },
      { tenantId: original.tenantId }
    );

    expect(updated.text).toBe("Updated text only");
    expect(updated.title).toBe("Original Title"); // Preserved
    expect(updated.version).toBe(2);
  });

  it("should return only latest versions (hidden=false) in list WITHOUT text", async () => {
    const v1 = await createKnowledgeText({
      text: "Version 1",
      title: "List Test Entry",
      tenantId: TEST_ORGANISATION_1.id,
      version: 1,
    });

    const v2 = await updateKnowledgeText(
      v1.id,
      { text: "Version 2" },
      { tenantId: v1.tenantId }
    );

    const v3 = await updateKnowledgeText(
      v2.id,
      { text: "Version 3" },
      { tenantId: v2.tenantId }
    );

    // Get list - should only return v3 (latest version) WITHOUT text
    const list = await getKnowledgeText({
      tenantId: TEST_ORGANISATION_1.id,
    });

    const listTestEntries = list.filter(
      (entry) => entry.title === "List Test Entry"
    );

    expect(listTestEntries.length).toBe(1); // Only one version
    expect(listTestEntries[0]?.id).toBe(v3.id); // The latest version
    expect(listTestEntries[0]?.version).toBe(3);
    expect(listTestEntries[0]?.hidden).toBe(false);
    // @ts-ignore
    expect(listTestEntries[0]?.text).toBeUndefined(); // Text NOT included
  });

  it("should get latest version by ID WITH full text content", async () => {
    const v1 = await createKnowledgeText({
      text: "Version 1 content",
      title: "Get By ID Test",
      tenantId: TEST_ORGANISATION_1.id,
    });

    const v2 = await updateKnowledgeText(
      v1.id,
      { text: "Version 2 content" },
      { tenantId: v1.tenantId }
    );

    // Get by ID should return latest version (v2) with full content
    const result = await getKnowledgeTextById(v1.id, {
      tenantId: v1.tenantId,
    });

    expect(result.id).toBe(v2.id);
    expect(result.version).toBe(2);
    expect(result.text).toBe("Version 2 content"); // Full text included
  });

  it("should get specific version by versionId", async () => {
    const v1 = await createKnowledgeText({
      text: "Version 1 specific",
      title: "Version ID Test",
      tenantId: TEST_ORGANISATION_1.id,
    });

    const v2 = await updateKnowledgeText(
      v1.id,
      { text: "Version 2 specific" },
      { tenantId: v1.tenantId }
    );

    // Get specific old version
    const result = await getKnowledgeTextById(v1.id, {
      tenantId: v1.tenantId,
      versionId: v1.id, // Get v1 specifically
    });

    expect(result.id).toBe(v1.id);
    expect(result.version).toBe(1);
    expect(result.text).toBe("Version 1 specific");
  });

  it("should return complete version history WITHOUT text content", async () => {
    const v1 = await createKnowledgeText({
      text: "Version 1",
      title: "History Test",
      tenantId: TEST_ORGANISATION_1.id,
      version: 1,
    });

    const v2 = await updateKnowledgeText(
      v1.id,
      { text: "Version 2" },
      { tenantId: v1.tenantId }
    );

    const v3 = await updateKnowledgeText(
      v2.id,
      { text: "Version 3" },
      { tenantId: v2.tenantId }
    );

    // Get history - should return all 3 versions chronologically WITHOUT text
    const history = await getKnowledgeTextHistory(v3.id, {
      tenantId: TEST_ORGANISATION_1.id,
    });

    expect(history.length).toBe(3);
    expect(history[0]?.id).toBe(v1.id); // Oldest first
    expect(history[0]?.version).toBe(1);
    // @ts-ignore
    expect(history[0]?.text).toBeUndefined(); // No text in history
    expect(history[1]?.id).toBe(v2.id);
    expect(history[1]?.version).toBe(2);
    // @ts-ignore
    expect(history[1]?.text).toBeUndefined(); // No text in history
    expect(history[2]?.id).toBe(v3.id); // Newest last
    expect(history[2]?.version).toBe(3);
    // @ts-ignore
    expect(history[2]?.text).toBeUndefined(); // No text in history
  });

  it("should return history starting from any version in chain", async () => {
    const v1 = await createKnowledgeText({
      text: "Version 1",
      title: "Chain Test",
      tenantId: TEST_ORGANISATION_1.id,
      version: 1,
    });

    const v2 = await updateKnowledgeText(
      v1.id,
      { text: "Version 2" },
      { tenantId: v1.tenantId }
    );

    const v3 = await updateKnowledgeText(
      v2.id,
      { text: "Version 3" },
      { tenantId: v2.tenantId }
    );

    const { getKnowledgeTextHistory } = await import("./knowledge-texts");

    // Get history starting from v2 - should still return all 3 versions
    const history = await getKnowledgeTextHistory(v2.id, {
      tenantId: TEST_ORGANISATION_1.id,
    });

    expect(history.length).toBe(3);
    expect(history[0]?.id).toBe(v1.id);
    expect(history[1]?.id).toBe(v2.id);
    expect(history[2]?.id).toBe(v3.id);
  });
});
