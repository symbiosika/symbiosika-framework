/**
 * Shared types/constants for webhook delivery. Kept in a tiny standalone module
 * so `dispatch.ts` and `delivery-job.ts` can both import them without creating
 * an import cycle.
 */
import type { WebhookEventEnvelope } from "./dispatch";

/** Job type registered with the background job queue for webhook delivery. */
export const WEBHOOK_DELIVERY_JOB_TYPE = "webhook.delivery";

/** Metadata persisted on a `webhook.delivery` job. */
export interface WebhookDeliveryJobMetadata {
  webhookId: string;
  tenantId: string;
  envelope: WebhookEventEnvelope;
  /** 1-based delivery attempt counter (incremented on each retry). */
  attempt: number;
}
