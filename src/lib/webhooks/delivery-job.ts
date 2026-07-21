/**
 * Background job handler that performs a single outgoing webhook delivery.
 *
 * Enqueued by `dispatchEvent` (dispatch.ts), one job per subscribed receiver.
 * Delivering out-of-band gives us:
 *   - isolation: a slow/broken receiver never blocks the triggering request,
 *   - retries: transient failures (network / 5xx) are retried with exponential
 *     backoff by re-enqueuing the job with a future `scheduledAt`.
 *
 * Client (4xx) errors are treated as permanent (the receiver rejected the
 * payload) and are not retried.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { webhooks } from "../db/schema/webhooks";
import { createJob } from "../jobs";
import type { JobHandlerRegister } from "../jobs";
import { fetchWithSsrfGuard, SsrfBlockedError } from "../utils/url-guard";
import { decryptAes } from "../crypt/aes";
import log from "../log";
import {
  WEBHOOK_DELIVERY_JOB_TYPE,
  type WebhookDeliveryJobMetadata,
} from "./delivery-types";
import {
  buildSignatureHeaders,
  DELIVERY_HEADER,
  EVENT_HEADER,
} from "./signature";

/** Max number of delivery attempts before the delivery is given up on. */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** Base backoff in ms; attempt N waits BASE * 2^(N-1) (30s, 1m, 2m, 4m). */
export const DELIVERY_BACKOFF_BASE_MS = 30_000;
/** Per-request timeout. */
export const DELIVERY_TIMEOUT_MS = 10_000;

const backoffMs = (attempt: number): number =>
  DELIVERY_BACKOFF_BASE_MS * 2 ** (attempt - 1);

/**
 * Execute one delivery attempt. Throws only on a retryable failure so the job
 * queue records the failure; the retry itself is scheduled as a NEW job before
 * throwing, so the failed row and the pending retry coexist.
 */
const deliver = async (
  metadata: WebhookDeliveryJobMetadata
): Promise<{ ok: true; statusCode: number } | { skipped: true }> => {
  const { webhookId, tenantId, envelope, attempt } = metadata;

  const webhook = await getDb().query.webhooks.findFirst({
    where: and(eq(webhooks.id, webhookId), eq(webhooks.tenantId, tenantId)),
  });

  // The webhook may have been deleted or disabled between enqueue and delivery.
  if (!webhook || !webhook.enabled) {
    log.debug(
      `Webhook ${webhookId} gone or disabled; skipping delivery of event ${envelope.event}`
    );
    return { skipped: true };
  }

  const rawBody = JSON.stringify(envelope);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [EVENT_HEADER]: envelope.event,
    [DELIVERY_HEADER]: envelope.id,
    ...((webhook.headers as Record<string, string>) || {}),
  };

  // Authenticate the delivery. HMAC is the default; 'headers' relies on the
  // static custom headers above; 'none' sends nothing extra.
  if (webhook.authMode === "hmac" && webhook.signingSecret) {
    const secret = decryptAes(
      webhook.signingSecret,
      "aes-256-cbc",
      webhook.signingSecretKeyVersion ?? 1
    ).value;
    Object.assign(headers, buildSignatureHeaders(secret, rawBody));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchWithSsrfGuard(webhook.webhookUrl, {
      method: webhook.method,
      headers,
      body: webhook.method !== "GET" ? rawBody : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof SsrfBlockedError) {
      // A blocked/invalid target is a configuration error, not transient.
      throw new NonRetryableDeliveryError(
        `Webhook URL not allowed: ${e.message}`
      );
    }
    // Network error / timeout → retryable.
    throw new Error(`Webhook request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (response.ok) {
    // best-effort last-used bookkeeping; never fail the delivery over it.
    await getDb()
      .update(webhooks)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(webhooks.id, webhook.id))
      .catch(() => {});
    return { ok: true, statusCode: response.status };
  }

  // 4xx (except 429) → the receiver rejected the payload; don't retry.
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    throw new NonRetryableDeliveryError(
      `Webhook rejected with status ${response.status}`
    );
  }

  // 5xx / 429 → transient; retry.
  throw new Error(`Webhook responded with status ${response.status}`);
};

/** Marks a failure that must NOT be retried (permanent). */
export class NonRetryableDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableDeliveryError";
  }
}

export const webhookDeliveryJobRegister: JobHandlerRegister = {
  type: WEBHOOK_DELIVERY_JOB_TYPE,
  handler: {
    async execute(metadata: WebhookDeliveryJobMetadata) {
      try {
        const result = await deliver(metadata);
        return result;
      } catch (e) {
        const isPermanent = e instanceof NonRetryableDeliveryError;
        const canRetry =
          !isPermanent && metadata.attempt < MAX_DELIVERY_ATTEMPTS;

        if (canRetry) {
          const nextAttempt = metadata.attempt + 1;
          const scheduledAt = new Date(
            Date.now() + backoffMs(metadata.attempt)
          ).toISOString();
          // Schedule the retry as a NEW job before this one fails, so the
          // retry is durably queued regardless of how this job row is recorded.
          await createJob(
            WEBHOOK_DELIVERY_JOB_TYPE,
            { ...metadata, attempt: nextAttempt },
            metadata.tenantId,
            scheduledAt
          );
          log.info(
            `Webhook delivery for ${metadata.webhookId} failed (attempt ${metadata.attempt}/${MAX_DELIVERY_ATTEMPTS}), retry #${nextAttempt} scheduled for ${scheduledAt}: ${(e as Error).message}`
          );
        } else {
          log.error(
            `Webhook delivery for ${metadata.webhookId} ${isPermanent ? "failed permanently" : `gave up after ${MAX_DELIVERY_ATTEMPTS} attempts`}: ${(e as Error).message}`
          );
        }
        // Re-throw so the job itself is marked failed (the retry, if any, is a
        // separate pending job).
        throw e;
      }
    },
  },
};
