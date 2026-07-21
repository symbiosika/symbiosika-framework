import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { webhooks } from "../db/schema/webhooks";
import { jobs } from "../db/schema/jobs";
import { createWebhook } from "./crud";
import { dispatchEvent } from "./dispatch";
import { WEBHOOK_DELIVERY_JOB_TYPE } from "./delivery-types";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../../test/init.test";

const TENANT = TEST_ORGANISATION_1.id;
const createdIds: string[] = [];

const makeWebhook = async (opts: {
  event: string;
  enabled?: boolean;
  tenantWide?: boolean;
  userId?: string;
}) => {
  const w = await createWebhook(TEST_ORG1_USER_1.id, {
    userId: TEST_ORG1_USER_1.id,
    tenantId: TENANT,
    name: `dispatch-test-${opts.event}-${createdIds.length}`,
    type: "n8n",
    event: opts.event,
    webhookUrl: "http://example.com/hook",
    tenantWide: opts.tenantWide ?? true,
    enabled: opts.enabled ?? true,
    authMode: "headers",
  });
  createdIds.push(w.id);
  return w;
};

/** Count enqueued delivery jobs whose target webhook is one we created. */
const deliveryJobsForCreated = async () => {
  const rows = await getDb()
    .select()
    .from(jobs)
    .where(eq(jobs.type, WEBHOOK_DELIVERY_JOB_TYPE));
  return rows.filter((r) =>
    createdIds.includes((r.metadata as any)?.webhookId)
  );
};

describe("dispatchEvent", () => {
  beforeAll(async () => {
    await initTests();
  });

  afterEach(async () => {
    // Clean up webhooks + their enqueued jobs so tests don't cross-contaminate.
    for (const id of createdIds) {
      await getDb().delete(webhooks).where(eq(webhooks.id, id));
    }
    const stale = await getDb()
      .select()
      .from(jobs)
      .where(eq(jobs.type, WEBHOOK_DELIVERY_JOB_TYPE));
    for (const job of stale) {
      if (createdIds.includes((job.metadata as any)?.webhookId)) {
        await getDb().delete(jobs).where(eq(jobs.id, job.id));
      }
    }
    createdIds.length = 0;
  });

  test("enqueues one delivery job per subscribed, enabled, tenant-wide webhook", async () => {
    await makeWebhook({ event: "knowledge_text.created" });
    await makeWebhook({ event: "knowledge_text.created" });
    // not subscribed to this event → must be ignored
    await makeWebhook({ event: "knowledge_text.deleted" });

    const result = await dispatchEvent(
      TENANT,
      "knowledge_text.created",
      { id: "page-1" },
      { source: "user" }
    );

    expect(result.enqueued).toBe(2);
    const enqueuedJobs = await deliveryJobsForCreated();
    expect(enqueuedJobs.length).toBe(2);

    // envelope carries the event + source and NO page text
    const env = (enqueuedJobs[0]!.metadata as any).envelope;
    expect(env.event).toBe("knowledge_text.created");
    expect(env.source).toBe("user");
    expect(env.data).toEqual({ id: "page-1" });
    // the payload data must never carry the page text
    expect(env.data).not.toHaveProperty("text");
  });

  test("disabled webhooks are never fired", async () => {
    await makeWebhook({ event: "knowledge_text.created", enabled: false });
    const result = await dispatchEvent(TENANT, "knowledge_text.created", {
      id: "x",
    });
    expect(result.enqueued).toBe(0);
    expect((await deliveryJobsForCreated()).length).toBe(0);
  });

  test("no subscribers → nothing enqueued", async () => {
    const result = await dispatchEvent(TENANT, "knowledge_text.updated", {
      id: "x",
    });
    expect(result.enqueued).toBe(0);
  });

  test("legacy stored event value 'chat-output' matches canonical 'chat.output'", async () => {
    await makeWebhook({ event: "chat-output" });
    const result = await dispatchEvent(TENANT, "chat.output", { msg: "hi" });
    expect(result.enqueued).toBe(1);
  });

  test("per-user (non-tenant-wide) webhook only fires for that user", async () => {
    await makeWebhook({
      event: "knowledge_text.created",
      tenantWide: false,
      userId: TEST_ORG1_USER_1.id,
    });

    // without the acting user → not delivered
    const noUser = await dispatchEvent(TENANT, "knowledge_text.created", {
      id: "x",
    });
    expect(noUser.enqueued).toBe(0);

    // with the matching acting user → delivered
    const withUser = await dispatchEvent(
      TENANT,
      "knowledge_text.created",
      { id: "x" },
      { userId: TEST_ORG1_USER_1.id }
    );
    expect(withUser.enqueued).toBe(1);
  });
});
