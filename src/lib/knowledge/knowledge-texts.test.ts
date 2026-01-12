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
      hidden: false,
    };

    const createdParent = await createKnowledgeText(parentText);
    expect(createdParent).toHaveProperty("id");
    expect(createdParent).toHaveProperty("documentId");
    expect(createdParent.version).toBe(1);
    expect(createdParent.isLatest).toBe(true);
    expect(createdParent.hidden).toBe(false);
    expect(createdParent.parentId).toBeNull();

    // Child in Wiki hierarchy (not a version!)
    const childText = {
      text: "Child knowledge text",
      title: "Child Title",
      tenantId: TEST_ORGANISATION_1.id,
      parentId: createdParent.id, // Wiki parent
      hidden: true, // System entry
    };

    const createdChild = await createKnowledgeText(childText);
    expect(createdChild).toHaveProperty("id");
    expect(createdChild).toHaveProperty("documentId");
    expect(createdChild.parentId).toBe(createdParent.documentId); // Now stores documentId, not id!
    expect(createdChild.documentId).not.toBe(createdParent.documentId); // Different document!
    expect(createdChild.version).toBe(1); // First version of this child document
    expect(createdChild.isLatest).toBe(true);
    expect(createdChild.hidden).toBe(true);
  });

  it("should create new version with incremented version and preserve hidden status", async () => {
    const newText = {
      text: "Text to be versioned",
      title: "Version Test",
      tenantId: TEST_ORGANISATION_1.id,
      hidden: false,
    };

    const createdText = await createKnowledgeText(newText);
    expect(createdText.version).toBe(1);
    expect(createdText.isLatest).toBe(true);

    const updatedText = await updateKnowledgeText(
      createdText.id,
      {
        text: "Updated text",
        hidden: true, // Change to system entry
      },
      {
        tenantId: createdText.tenantId,
      }
    );

    expect(updatedText.version).toBe(2); // Auto-incremented
    expect(updatedText.hidden).toBe(true); // Updated
    expect(updatedText.isLatest).toBe(true); // New version is latest
    expect(updatedText.id).not.toBe(createdText.id); // New version has new ID
    expect(updatedText.documentId).toBe(createdText.documentId); // Same document
  });

  it("should create a new version instead of overwriting on update", async () => {
    const originalText = {
      text: "Original text content",
      title: "Original Title",
      tenantId: TEST_ORGANISATION_1.id,
      hidden: false,
    };

    const created = await createKnowledgeText(originalText);
    const originalId = created.id;
    const documentId = created.documentId;

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
    expect(updated.isLatest).toBe(true);
    expect(updated.id).not.toBe(originalId); // New ID
    expect(updated.documentId).toBe(documentId); // Same document
    expect(updated.parentId).toBe(created.parentId); // Wiki parent preserved

    // Original should be marked as NOT latest - check via getKnowledgeTextById with versionId
    const originalCheck = await getKnowledgeTextById(originalId, {
      tenantId: created.tenantId,
      versionId: originalId, // Get specific old version
    });
    expect(originalCheck).toBeDefined();
    expect(originalCheck.isLatest).toBe(false); // No longer latest
  });

  it("should preserve documentId and Wiki parentId across multiple updates", async () => {
    const v1 = await createKnowledgeText({
      text: "Version 1",
      title: "Chain Test",
      tenantId: TEST_ORGANISATION_1.id,
    });
    const documentId = v1.documentId;

    const v2 = await updateKnowledgeText(
      v1.id,
      { text: "Version 2" },
      { tenantId: v1.tenantId }
    );
    expect(v2.version).toBe(2);
    expect(v2.documentId).toBe(documentId); // Same document
    expect(v2.parentId).toBe(v1.parentId); // Wiki parent preserved (both null)

    const v3 = await updateKnowledgeText(
      v2.id,
      { text: "Version 3" },
      { tenantId: v2.tenantId }
    );
    expect(v3.version).toBe(3);
    expect(v3.documentId).toBe(documentId); // Still same document
    expect(v3.parentId).toBe(v1.parentId); // Wiki parent still preserved

    // Check all versions using versionId
    const v1Check = await getKnowledgeTextById(v1.id, {
      tenantId: v1.tenantId,
      versionId: v1.id,
    });
    expect(v1Check.isLatest).toBe(false); // Old version

    const v2Check = await getKnowledgeTextById(v2.id, {
      tenantId: v2.tenantId,
      versionId: v2.id,
    });
    expect(v2Check.isLatest).toBe(false); // Old version

    // Get latest version - should be v3
    const latestCheck = await getKnowledgeTextById(v1.id, {
      tenantId: v3.tenantId,
    });
    expect(latestCheck.id).toBe(v3.id);
    expect(latestCheck.isLatest).toBe(true); // Latest version
  });

  it("should only update specified fields in new version", async () => {
    const original = await createKnowledgeText({
      text: "Original text",
      title: "Original Title",
      tenantId: TEST_ORGANISATION_1.id,
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
    expect(updated.documentId).toBe(original.documentId);
  });

  it("should return only latest versions (isLatest=true) in list WITHOUT text", async () => {
    const v1 = await createKnowledgeText({
      text: "Version 1",
      title: "List Test Entry",
      tenantId: TEST_ORGANISATION_1.id,
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
    expect(listTestEntries[0]?.isLatest).toBe(true);
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
    expect(history[0]?.documentId).toBe(v1.documentId);
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

  it("should return history starting from any version in documentId chain", async () => {
    const v1 = await createKnowledgeText({
      text: "Version 1",
      title: "Chain Test",
      tenantId: TEST_ORGANISATION_1.id,
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

    // Get history starting from v2 - should still return all 3 versions (same documentId)
    const history = await getKnowledgeTextHistory(v2.id, {
      tenantId: TEST_ORGANISATION_1.id,
    });

    expect(history.length).toBe(3);
    expect(history[0]?.id).toBe(v1.id);
    expect(history[1]?.id).toBe(v2.id);
    expect(history[2]?.id).toBe(v3.id);
  });

  it("should maintain parent-child hierarchy after parent update", async () => {
    // Create parent entry
    const parent = await createKnowledgeText({
      text: "Parent text v1",
      title: "Parent Entry",
      tenantId: TEST_ORGANISATION_1.id,
    });

    // Create child entry with parentId pointing to parent
    const child = await createKnowledgeText({
      text: "Child text",
      title: "Child Entry",
      tenantId: TEST_ORGANISATION_1.id,
      parentId: parent.id, // This should be converted to parent.documentId
    });

    // Verify child's parentId is set to parent's documentId
    expect(child.parentId).toBe(parent.documentId);

    // Update parent (creates new version with new id)
    const parentV2 = await updateKnowledgeText(
      parent.id,
      { text: "Parent text v2", title: "Updated Parent Entry" },
      { tenantId: parent.tenantId }
    );

    // Parent should have new id but same documentId
    expect(parentV2.id).not.toBe(parent.id);
    expect(parentV2.documentId).toBe(parent.documentId);

    // Get child again - parentId should still point to parent's documentId
    const childCheck = await getKnowledgeTextById(child.id, {
      tenantId: TEST_ORGANISATION_1.id,
    });

    expect(childCheck.parentId).toBe(parent.documentId);
    expect(childCheck.parentId).toBe(parentV2.documentId); // Same documentId across versions

    // Create another child after parent update
    const child2 = await createKnowledgeText({
      text: "Second child text",
      title: "Second Child Entry",
      tenantId: TEST_ORGANISATION_1.id,
      parentId: parentV2.id, // Use new version's id
    });

    // Second child should also have parent's documentId
    expect(child2.parentId).toBe(parent.documentId);
    expect(child2.parentId).toBe(parentV2.documentId);
  });

  it("should allow creating and updating knowledge text with empty text", async () => {
    // Create entry with empty text
    const emptyText = await createKnowledgeText({
      text: "",
      title: "Entry with empty text",
      tenantId: TEST_ORGANISATION_1.id,
    });

    expect(emptyText).toHaveProperty("id");
    expect(emptyText.text).toBe("");
    expect(emptyText.title).toBe("Entry with empty text");
    expect(emptyText.isLatest).toBe(true);

    // Update to empty text should also work
    const updated = await updateKnowledgeText(
      emptyText.id,
      { text: "" },
      { tenantId: emptyText.tenantId }
    );

    expect(updated.text).toBe("");
    expect(updated.version).toBe(2);
    expect(updated.isLatest).toBe(true);
    expect(updated.documentId).toBe(emptyText.documentId);

    // Entry should still be visible in list
    const list = await getKnowledgeText({
      tenantId: TEST_ORGANISATION_1.id,
    });

    const foundEntry = list.find((e) => e.documentId === emptyText.documentId);
    expect(foundEntry).toBeDefined();
    expect(foundEntry?.id).toBe(updated.id); // Latest version
    expect(foundEntry?.isLatest).toBe(true);
  });

  it("should not break hierarchy when parent is updated with empty text", async () => {
    // Create parent with content
    const parent = await createKnowledgeText({
      text: "Parent with content",
      title: "Parent Entry",
      tenantId: TEST_ORGANISATION_1.id,
    });

    // Create child
    const child = await createKnowledgeText({
      text: "Child text",
      title: "Child Entry",
      tenantId: TEST_ORGANISATION_1.id,
      parentId: parent.id,
    });

    expect(child.parentId).toBe(parent.documentId);

    // Update parent with empty text
    const parentV2 = await updateKnowledgeText(
      parent.id,
      { text: "" },
      { tenantId: parent.tenantId }
    );

    expect(parentV2.text).toBe("");
    expect(parentV2.isLatest).toBe(true);
    expect(parentV2.documentId).toBe(parent.documentId);

    // Child should still have correct parent reference
    const childCheck = await getKnowledgeTextById(child.id, {
      tenantId: TEST_ORGANISATION_1.id,
    });

    expect(childCheck.parentId).toBe(parent.documentId);
    expect(childCheck.parentId).toBe(parentV2.documentId);

    // Both parent and child should be visible in list
    const list = await getKnowledgeText({
      tenantId: TEST_ORGANISATION_1.id,
    });

    const foundParent = list.find((e) => e.documentId === parent.documentId);
    const foundChild = list.find((e) => e.documentId === child.documentId);

    expect(foundParent).toBeDefined();
    expect(foundParent?.id).toBe(parentV2.id); // Latest version with empty text
    expect(foundChild).toBeDefined();
    expect(foundChild?.parentId).toBe(parent.documentId);
  });
});
