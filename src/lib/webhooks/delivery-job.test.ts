import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "bun:test";
import { createServer, type Server } from "http";
import { eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { webhooks } from "../db/schema/webhooks";
import { jobs } from "../db/schema/jobs";
import { createWebhook } from "./crud";
import { encryptAes } from "../crypt/aes";
import {
  webhookDeliveryJobRegister,
  NonRetryableDeliveryError,
} from "./delivery-job";
import { WEBHOOK_DELIVERY_JOB_TYPE } from "./delivery-types";
import type { WebhookDeliveryJobMetadata } from "./delivery-types";
import type { WebhookEventEnvelope } from "./dispatch";
import { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_HEADER } from "./signature";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../../test/init.test";

const TENANT = TEST_ORGANISATION_1.id;
const PORT = 3998;
const SECRET = "whsec_deliverytestsecret";

let server: Server;
let nextStatus = 200;
let lastRequest: { headers: Record<string, string>; body: string } | null =
  null;

const execute = (metadata: WebhookDeliveryJobMetadata) =>
  webhookDeliveryJobRegister.handler.execute(metadata, {} as any);

const makeEnvelope = (): WebhookEventEnvelope => ({
  id: "11111111-1111-1111-1111-111111111111",
  event: "knowledge_text.created",
  source: "user",
  tenantId: TENANT,
  occurredAt: "2026-01-01T00:00:00.000Z",
  data: { id: "page-42" },
});

const createHmacWebhook = async () => {
  process.env.SSRF_ALLOW_PRIVATE_TARGETS = "true";
  const enc = encryptAes(SECRET);
  return createWebhook(TEST_ORG1_USER_1.id, {
    userId: TEST_ORG1_USER_1.id,
    tenantId: TENANT,
    name: `delivery-test-${Date.now()}`,
    type: "n8n",
    event: "knowledge_text.created",
    webhookUrl: `http://127.0.0.1:${PORT}/hook`,
    tenantWide: true,
    authMode: "hmac",
    signingSecret: enc.value,
    signingSecretKeyVersion: enc.keyVersion,
  });
};

const retryJobsFor = async (webhookId: string) => {
  const rows = await getDb()
    .select()
    .from(jobs)
    .where(eq(jobs.type, WEBHOOK_DELIVERY_JOB_TYPE));
  return rows.filter((r) => (r.metadata as any)?.webhookId === webhookId);
};

describe("webhook delivery job", () => {
  beforeAll(async () => {
    await initTests();
    process.env.SSRF_ALLOW_PRIVATE_TARGETS = "true";
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c.toString()));
      req.on("end", () => {
        lastRequest = {
          headers: req.headers as Record<string, string>,
          body,
        };
        res.writeHead(nextStatus);
        res.end("");
      });
    }).listen(PORT);
  });

  afterAll(() => {
    server.close();
  });

  afterEach(async () => {
    // remove test webhooks + any enqueued retry jobs
    const rows = await getDb().select().from(jobs).where(eq(jobs.type, WEBHOOK_DELIVERY_JOB_TYPE));
    for (const job of rows) {
      const meta = job.metadata as any;
      if (typeof meta?.webhookId === "string") {
        const wh = await getDb().query.webhooks.findFirst({
          where: eq(webhooks.id, meta.webhookId),
        });
        if (wh?.name?.startsWith("delivery-test-")) {
          await getDb().delete(jobs).where(eq(jobs.id, job.id));
        }
      }
    }
    await getDb().delete(webhooks).where(eq(webhooks.tenantId, TENANT));
    lastRequest = null;
  });

  test("successful delivery sends a valid HMAC signature and event headers", async () => {
    nextStatus = 200;
    const webhook = await createHmacWebhook();
    const envelope = makeEnvelope();

    const result = await execute({
      webhookId: webhook.id,
      tenantId: TENANT,
      envelope,
      attempt: 1,
    });

    expect((result as any).ok).toBe(true);
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.headers[EVENT_HEADER.toLowerCase()]).toBe(
      "knowledge_text.created"
    );

    // the received body must verify against the signature headers
    const ok = verifySignature({
      secret: SECRET,
      payload: lastRequest!.body,
      signatureHeader: lastRequest!.headers[SIGNATURE_HEADER.toLowerCase()],
      timestampHeader: lastRequest!.headers[TIMESTAMP_HEADER.toLowerCase()],
    });
    expect(ok).toBe(true);

    // the delivered body is exactly the envelope (and carries no page text)
    expect(JSON.parse(lastRequest!.body).data).toEqual({ id: "page-42" });
  });

  test("a 5xx response schedules a retry with an incremented attempt", async () => {
    nextStatus = 500;
    const webhook = await createHmacWebhook();

    await expect(
      execute({
        webhookId: webhook.id,
        tenantId: TENANT,
        envelope: makeEnvelope(),
        attempt: 1,
      })
    ).rejects.toThrow();

    const retries = await retryJobsFor(webhook.id);
    // one retry job with attempt=2 and a future scheduledAt
    const retry = retries.find((r) => (r.metadata as any).attempt === 2);
    expect(retry).toBeDefined();
    expect(retry!.scheduledAt).not.toBeNull();
  });

  test("a 4xx response is permanent — no retry is scheduled", async () => {
    nextStatus = 400;
    const webhook = await createHmacWebhook();

    await expect(
      execute({
        webhookId: webhook.id,
        tenantId: TENANT,
        envelope: makeEnvelope(),
        attempt: 1,
      })
    ).rejects.toBeInstanceOf(NonRetryableDeliveryError);

    const retries = await retryJobsFor(webhook.id);
    expect(retries.find((r) => (r.metadata as any).attempt === 2)).toBeUndefined();
  });

  test("gives up (no retry) once the max attempts is reached", async () => {
    nextStatus = 500;
    const webhook = await createHmacWebhook();

    await expect(
      execute({
        webhookId: webhook.id,
        tenantId: TENANT,
        envelope: makeEnvelope(),
        attempt: 5, // already at MAX_DELIVERY_ATTEMPTS
      })
    ).rejects.toThrow();

    const retries = await retryJobsFor(webhook.id);
    expect(retries.find((r) => (r.metadata as any).attempt === 6)).toBeUndefined();
  });
});
