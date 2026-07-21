/**
 * Central event dispatcher for OUTGOING webhooks.
 *
 * `dispatchEvent` is the one call sites use to fire an event. It looks up every
 * enabled webhook in the tenant that subscribes to the event and enqueues one
 * asynchronous delivery job per receiver (see delivery-job.ts). Delivery is
 * intentionally NOT done inline so a slow or broken receiver can never block or
 * fail the business operation (a knowledge page write, a chat output, ...).
 *
 * Contract: dispatchEvent NEVER throws. A failure to enqueue is logged and
 * swallowed — emitting a webhook is a side effect and must not break the
 * primary action.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { webhooks } from "../db/schema/webhooks";
import { createJob } from "../jobs";
import log from "../log";
import { resolveWebhookEvent, type WebhookEvent } from "./events";
import {
  WEBHOOK_DELIVERY_JOB_TYPE,
  type WebhookDeliveryJobMetadata,
} from "./delivery-types";

/** Where an event originated — lets receivers distinguish e.g. user vs sync. */
export type WebhookEventSource =
  | "user"
  | "sync"
  | "sync-orphan"
  | "system"
  | string;

export interface DispatchEventOptions {
  /** Who/what caused the event (defaults to "user"). */
  source?: WebhookEventSource;
  /**
   * The acting user, if any. When set, per-user webhooks (tenantWide = false)
   * owned by that user also receive the event; otherwise only tenant-wide
   * webhooks do.
   */
  userId?: string;
  /** ISO timestamp of when the event occurred (defaults to now). */
  occurredAt?: string;
}

/** The JSON envelope delivered to the receiver as the request body. */
export interface WebhookEventEnvelope {
  /** Unique id of this event occurrence (also sent as X-Symbiosika-Delivery). */
  id: string;
  event: WebhookEvent;
  source: WebhookEventSource;
  tenantId: string;
  occurredAt: string;
  data: unknown;
}

/**
 * Dispatch an event to all subscribed, enabled webhooks of a tenant.
 * Returns the number of delivery jobs enqueued (0 if nothing subscribed).
 */
export const dispatchEvent = async (
  tenantId: string,
  event: WebhookEvent,
  data: unknown,
  options: DispatchEventOptions = {}
): Promise<{ enqueued: number }> => {
  try {
    const rows = await getDb().query.webhooks.findMany({
      where: and(eq(webhooks.tenantId, tenantId), eq(webhooks.enabled, true)),
    });

    // Match on the RESOLVED event so legacy ("chat-output") and canonical
    // ("chat.output") stored values both subscribe to the same event.
    const subscribed = rows.filter((w) => {
      if (resolveWebhookEvent(w.event) !== event) return false;
      if (w.tenantWide) return true;
      return options.userId != null && w.userId === options.userId;
    });

    if (subscribed.length === 0) {
      return { enqueued: 0 };
    }

    const envelope: WebhookEventEnvelope = {
      id: randomUUID(),
      event,
      source: options.source ?? "user",
      tenantId,
      occurredAt: options.occurredAt ?? new Date().toISOString(),
      data,
    };

    let enqueued = 0;
    for (const webhook of subscribed) {
      try {
        const metadata: WebhookDeliveryJobMetadata = {
          webhookId: webhook.id,
          tenantId,
          envelope,
          attempt: 1,
        };
        await createJob(WEBHOOK_DELIVERY_JOB_TYPE, metadata, tenantId);
        enqueued++;
      } catch (e) {
        log.error(
          `Failed to enqueue webhook delivery for webhook ${webhook.id} (event ${event}): ${(e as Error).message}`
        );
      }
    }

    return { enqueued };
  } catch (e) {
    // Never let event dispatch break the caller's primary operation.
    log.error(
      `dispatchEvent failed for event ${event} / tenant ${tenantId}: ${(e as Error).message}`
    );
    return { enqueued: 0 };
  }
};
