import { describe, it, expect, beforeAll } from "bun:test";
import {
  createKnowledgeText,
  getKnowledgeText,
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

  it("should read a knowledge text entry by ID", async () => {
    const newText = {
      text: "Another test knowledge text",
      title: "Another Test Title",
      tenantId: TEST_ORGANISATION_1.id,
    };

    const createdText = await createKnowledgeText(newText);
    const readText = await getKnowledgeText({
      id: createdText.id,
      tenantId: createdText.tenantId,
    });

    expect(readText.length).toBe(1);
    if (!readText[0]) return; // end test if readText is undefined
    expect(readText[0].text).toBe(newText.text);
    expect(readText[0].title).toBe(newText.title);
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

    const readText = await getKnowledgeText({
      id: createdText.id,
      tenantId: createdText.tenantId,
    });
    expect(readText.length).toBe(0);
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

    // Original should be marked as hidden
    const originalCheck = await getKnowledgeText({
      id: originalId,
      tenantId: created.tenantId,
    });
    expect(originalCheck[0]).toBeDefined();
    expect(originalCheck[0]?.hidden).toBe(true);
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

    // Check all versions are accessible but old ones are hidden
    const v1Check = await getKnowledgeText({
      id: v1.id,
      tenantId: v1.tenantId,
    });
    expect(v1Check[0]?.hidden).toBe(true);

    const v2Check = await getKnowledgeText({
      id: v2.id,
      tenantId: v2.tenantId,
    });
    expect(v2Check[0]?.hidden).toBe(true);

    const v3Check = await getKnowledgeText({
      id: v3.id,
      tenantId: v3.tenantId,
    });
    expect(v3Check[0]?.hidden).toBe(false); // Latest version is visible
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
});
