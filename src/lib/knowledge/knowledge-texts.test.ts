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

  it("should update a knowledge text entry and create history", async () => {
    const newText = {
      text: "Text to be updated",
      title: "Title to be updated",
      tenantId: TEST_ORGANISATION_1.id,
    };

    const createdText = await createKnowledgeText(newText);
    const originalId = createdText.id;
    
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

    // Should update the same entry (same ID)
    expect(updatedText.id).toBe(originalId);
    expect(updatedText.text).toBe("Updated text");
    expect(updatedText.title).toBe("Updated title");
    
    // History should be created
    const history = await getKnowledgeTextHistory(originalId, {
      tenantId: TEST_ORGANISATION_1.id,
    });
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.text).toBe("Text to be updated");
    expect(history[0]?.title).toBe("Title to be updated");
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

  it("should create a knowledge text with hidden and parentId attributes", async () => {
    const parentText = {
      text: "Parent knowledge text",
      title: "Parent Title",
      tenantId: TEST_ORGANISATION_1.id,
      hidden: false,
    };

    const createdParent = await createKnowledgeText(parentText);
    expect(createdParent).toHaveProperty("id");
    expect(createdParent.hidden).toBe(false);
    expect(createdParent.parentId).toBeNull();

    // Child in Wiki hierarchy
    const childText = {
      text: "Child knowledge text",
      title: "Child Title",
      tenantId: TEST_ORGANISATION_1.id,
      parentId: createdParent.id, // Wiki parent
      hidden: true, // System entry
    };

    const createdChild = await createKnowledgeText(childText);
    expect(createdChild).toHaveProperty("id");
    expect(createdChild.parentId).toBe(createdParent.id); // Now stores id directly!
    expect(createdChild.id).not.toBe(createdParent.id); // Different entry!
    expect(createdChild.hidden).toBe(true);
  });

  it("should preserve hidden status on update", async () => {
    const newText = {
      text: "Text with hidden status",
      title: "Hidden Test",
      tenantId: TEST_ORGANISATION_1.id,
      hidden: false,
    };

    const createdText = await createKnowledgeText(newText);
    expect(createdText.hidden).toBe(false);

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

    expect(updatedText.hidden).toBe(true); // Updated
    expect(updatedText.id).toBe(createdText.id); // Same entry updated
  });

  it("should update entry in place (not create new version)", async () => {
    const originalText = {
      text: "Original text content",
      title: "Original Title",
      tenantId: TEST_ORGANISATION_1.id,
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

    // Should be the same entry (same ID)
    expect(updated.id).toBe(originalId);
    expect(updated.text).toBe("Updated text content");
    expect(updated.title).toBe("Updated Title");
    expect(updated.hidden).toBe(false);
    expect(updated.parentId).toBe(created.parentId); // Wiki parent preserved
    
    // History should contain old version
    const history = await getKnowledgeTextHistory(originalId, {
      tenantId: TEST_ORGANISATION_1.id,
    });
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.text).toBe("Original text content");
  });

  it("should preserve parentId across multiple updates", async () => {
    const v1 = await createKnowledgeText({
      text: "Version 1",
      title: "Chain Test",
      tenantId: TEST_ORGANISATION_1.id,
    });
    const originalId = v1.id;

    const v2 = await updateKnowledgeText(
      v1.id,
      { text: "Version 2" },
      { tenantId: v1.tenantId }
    );
    expect(v2.id).toBe(originalId); // Same entry
    expect(v2.parentId).toBe(v1.parentId); // Wiki parent preserved (both null)

    const v3 = await updateKnowledgeText(
      v2.id,
      { text: "Version 3" },
      { tenantId: v2.tenantId }
    );
    expect(v3.id).toBe(originalId); // Still same entry
    expect(v3.parentId).toBe(v1.parentId); // Wiki parent still preserved
    
    // History should show all changes
    const history = await getKnowledgeTextHistory(originalId, {
      tenantId: TEST_ORGANISATION_1.id,
    });
    expect(history.length).toBe(2); // 2 updates = 2 history entries
  });

  it("should only update specified fields", async () => {
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
    expect(updated.id).toBe(original.id); // Same entry
  });

  it("should return all entries in list WITHOUT text", async () => {
    const entry1 = await createKnowledgeText({
      text: "Entry 1 text",
      title: "List Test Entry 1",
      tenantId: TEST_ORGANISATION_1.id,
    });

    await updateKnowledgeText(
      entry1.id,
      { text: "Entry 1 updated" },
      { tenantId: entry1.tenantId }
    );

    // Get list - should return the entry WITHOUT text
    const list = await getKnowledgeText({
      tenantId: TEST_ORGANISATION_1.id,
    });

    const listTestEntries = list.filter(
      (entry) => entry.title === "List Test Entry 1"
    );

    expect(listTestEntries.length).toBe(1);
    expect(listTestEntries[0]?.id).toBe(entry1.id);
    // @ts-ignore
    expect(listTestEntries[0]?.text).toBeUndefined(); // Text NOT included
  });

  it("should get entry by ID WITH full text content", async () => {
    const entry = await createKnowledgeText({
      text: "Entry content",
      title: "Get By ID Test",
      tenantId: TEST_ORGANISATION_1.id,
    });

    await updateKnowledgeText(
      entry.id,
      { text: "Updated content" },
      { tenantId: entry.tenantId }
    );

    // Get by ID should return current entry with full content
    const result = await getKnowledgeTextById(entry.id, {
      tenantId: entry.tenantId,
    });

    expect(result.id).toBe(entry.id);
    expect(result.text).toBe("Updated content"); // Full text included
  });

  it("should return complete version history", async () => {
    const entry = await createKnowledgeText({
      text: "Version 1",
      title: "History Test",
      tenantId: TEST_ORGANISATION_1.id,
    });

    await updateKnowledgeText(
      entry.id,
      { text: "Version 2" },
      { tenantId: entry.tenantId }
    );

    await updateKnowledgeText(
      entry.id,
      { text: "Version 3" },
      { tenantId: entry.tenantId }
    );

    // Get history - should return all previous versions
    const history = await getKnowledgeTextHistory(entry.id, {
      tenantId: TEST_ORGANISATION_1.id,
    });

    expect(history.length).toBe(2); // 2 updates = 2 history entries
    expect(history[0]?.text).toBe("Version 2"); // Newest first (descending order)
    expect(history[1]?.text).toBe("Version 1"); // Oldest last
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
      parentId: parent.id,
    });

    // Verify child's parentId is set to parent's id
    expect(child.parentId).toBe(parent.id);

    // Update parent (same id, just updated content)
    const parentUpdated = await updateKnowledgeText(
      parent.id,
      { text: "Parent text v2", title: "Updated Parent Entry" },
      { tenantId: parent.tenantId }
    );

    // Parent should have same id
    expect(parentUpdated.id).toBe(parent.id);

    // Get child again - parentId should still point to parent's id
    const childCheck = await getKnowledgeTextById(child.id, {
      tenantId: TEST_ORGANISATION_1.id,
    });

    expect(childCheck.parentId).toBe(parent.id);
    expect(childCheck.parentId).toBe(parentUpdated.id); // Same ID

    // Create another child after parent update
    const child2 = await createKnowledgeText({
      text: "Second child text",
      title: "Second Child Entry",
      tenantId: TEST_ORGANISATION_1.id,
      parentId: parentUpdated.id,
    });

    // Second child should also have parent's id
    expect(child2.parentId).toBe(parent.id);
    expect(child2.parentId).toBe(parentUpdated.id);
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

    // Update to empty text should also work
    const updated = await updateKnowledgeText(
      emptyText.id,
      { text: "" },
      { tenantId: emptyText.tenantId }
    );

    expect(updated.text).toBe("");
    expect(updated.id).toBe(emptyText.id); // Same entry

    // Entry should still be visible in list
    const list = await getKnowledgeText({
      tenantId: TEST_ORGANISATION_1.id,
    });

    const foundEntry = list.find((e) => e.id === emptyText.id);
    expect(foundEntry).toBeDefined();
    expect(foundEntry?.id).toBe(emptyText.id);
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

    expect(child.parentId).toBe(parent.id);

    // Update parent with empty text
    const parentUpdated = await updateKnowledgeText(
      parent.id,
      { text: "" },
      { tenantId: parent.tenantId }
    );

    expect(parentUpdated.text).toBe("");
    expect(parentUpdated.id).toBe(parent.id); // Same entry

    // Child should still have correct parent reference
    const childCheck = await getKnowledgeTextById(child.id, {
      tenantId: TEST_ORGANISATION_1.id,
    });

    expect(childCheck.parentId).toBe(parent.id);
    expect(childCheck.parentId).toBe(parentUpdated.id); // Same ID

    // Both parent and child should be visible in list
    const list = await getKnowledgeText({
      tenantId: TEST_ORGANISATION_1.id,
    });

    const foundParent = list.find((e) => e.id === parent.id);
    const foundChild = list.find((e) => e.id === child.id);

    expect(foundParent).toBeDefined();
    expect(foundParent?.id).toBe(parent.id);
    expect(foundChild).toBeDefined();
    expect(foundChild?.parentId).toBe(parent.id);
  });
});
