import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { webhooks } from "../db/schema/webhooks";
import { jobs } from "../db/schema/jobs";
import { createWebhook } from "../webhooks/crud";
import { WEBHOOK_DELIVERY_JOB_TYPE } from "../webhooks/delivery-types";
import {
  createKnowledgeText,
  updateKnowledgeText,
  deleteKnowledgeText,
} from "./knowledge-texts";
import { syncKnowledgeTextBlocks } from "./knowledge-text-blocks";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../../test/init.test";

const TENANT = TEST_ORGANISATION_1.id;
const createdWebhookIds: string[] = [];

/** All delivery-job envelopes fired for a given page id. */
const envelopesForPage = async (pageId: string) => {
  const rows = await getDb()
    .select()
    .from(jobs)
    .where(eq(jobs.type, WEBHOOK_DELIVERY_JOB_TYPE));
  return rows
    .map((r) => (r.metadata as any)?.envelope)
    .filter((env) => env && env.data?.id === pageId);
};

describe("knowledge_text lifecycle webhook events", () => {
  beforeAll(async () => {
    await initTests();
    // subscribe a tenant-wide webhook to each knowledge_text event
    for (const event of [
      "knowledge_text.created",
      "knowledge_text.updated",
      "knowledge_text.deleted",
    ]) {
      const w = await createWebhook(TEST_ORG1_USER_1.id, {
        userId: TEST_ORG1_USER_1.id,
        tenantId: TENANT,
        name: `kt-events-${event}`,
        type: "n8n",
        event,
        webhookUrl: "http://example.com/hook",
        tenantWide: true,
        authMode: "headers",
      });
      createdWebhookIds.push(w.id);
    }
  });

  afterAll(async () => {
    for (const id of createdWebhookIds) {
      await getDb().delete(webhooks).where(eq(webhooks.id, id));
    }
  });

  test("createKnowledgeText fires knowledge_text.created (source=user, no text)", async () => {
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: "Event Page",
      text: "some secret body content",
    });

    const envelopes = await envelopesForPage(page.id);
    const created = envelopes.find((e) => e.event === "knowledge_text.created");
    expect(created).toBeDefined();
    expect(created.source).toBe("user");
    expect(created.data.id).toBe(page.id);
    expect(created.data.title).toBe("Event Page");
    // the page text must never be part of the payload
    expect(created.data).not.toHaveProperty("text");
    expect(JSON.stringify(created.data)).not.toContain("secret body");
  });

  test("updateKnowledgeText fires knowledge_text.updated", async () => {
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: "To Update",
      text: "v1",
    });
    await updateKnowledgeText(
      page.id,
      { title: "Updated Title" },
      { tenantId: TENANT }
    );

    const envelopes = await envelopesForPage(page.id);
    const updated = envelopes.find((e) => e.event === "knowledge_text.updated");
    expect(updated).toBeDefined();
    expect(updated.source).toBe("user");
    expect(updated.data.title).toBe("Updated Title");
  });

  test("deleteKnowledgeText fires knowledge_text.deleted (data = id only)", async () => {
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: "To Delete",
      text: "bye",
    });
    await deleteKnowledgeText(page.id, {
      tenantId: TENANT,
    });

    const envelopes = await envelopesForPage(page.id);
    const deleted = envelopes.find((e) => e.event === "knowledge_text.deleted");
    expect(deleted).toBeDefined();
    expect(deleted.data).toEqual({ id: page.id });
  });

  test("source flows through as 'sync' when set", async () => {
    const page = await createKnowledgeText(
      { tenantId: TENANT, title: "Synced", text: "x" },
      { source: "sync" }
    );

    const envelopes = await envelopesForPage(page.id);
    const created = envelopes.find((e) => e.event === "knowledge_text.created");
    expect(created).toBeDefined();
    expect(created.source).toBe("sync");
  });

  test("a block-editor save fires knowledge_text.updated", async () => {
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: "Block Page",
      text: "",
    });

    await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: "# Hello block" }],
      { tenantId: TENANT }
    );

    const envelopes = await envelopesForPage(page.id);
    // at least one updated event from the block save
    const updated = envelopes.filter((e) => e.event === "knowledge_text.updated");
    expect(updated.length).toBeGreaterThanOrEqual(1);
    expect(updated.every((e) => !("text" in e.data))).toBe(true);
  });
});
