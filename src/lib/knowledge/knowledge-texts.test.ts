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

  it("should update version and hidden attributes", async () => {
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
        version: 2,
        hidden: true,
      },
      {
        tenantId: createdText.tenantId,
      }
    );

    expect(updatedText.version).toBe(2);
    expect(updatedText.hidden).toBe(true);
  });
});
