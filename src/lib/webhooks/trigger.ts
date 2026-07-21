import { getDb } from "../db/db-connection";
import { webhooks } from "../db/schema/webhooks";
import { and, eq } from "drizzle-orm";
import { fetchWithSsrfGuard, SsrfBlockedError } from "../utils/url-guard";
import { decryptAes } from "../crypt/aes";
import {
  buildSignatureHeaders,
  DELIVERY_HEADER,
  EVENT_HEADER,
} from "./signature";
import { randomUUID } from "node:crypto";

export interface WebhookTriggerOptions {
  payload?: any;
  headers?: Record<string, string>;
}

export class WebhookTriggerError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
  }
}

/**
 * Trigger a webhook by its ID (manual / on-demand delivery).
 *
 * Unlike the event dispatcher this sends synchronously and returns the receiver
 * response, but it uses the SAME authentication scheme: when the webhook is set
 * to HMAC auth the body is signed so the receiver can verify the origin.
 */
export const triggerWebhook = async (
  webhookId: string,
  tenantId: string,
  options: WebhookTriggerOptions = {}
) => {
  // Get webhook details (scoped to the tenant; any event/type is triggerable)
  const webhook = await getDb().query.webhooks.findFirst({
    where: and(eq(webhooks.id, webhookId), eq(webhooks.tenantId, tenantId)),
  });

  if (!webhook) {
    throw new WebhookTriggerError("Webhook not found", 404);
  }

  const rawBody =
    webhook.method !== "GET" ? JSON.stringify(options.payload ?? {}) : undefined;

  // Prepare headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [EVENT_HEADER]: webhook.event,
    [DELIVERY_HEADER]: randomUUID(),
    ...((webhook.headers as Record<string, string>) || {}),
    ...(options.headers || {}),
  };

  // Sign the body when the webhook uses HMAC auth.
  if (
    webhook.authMode === "hmac" &&
    webhook.signingSecret &&
    rawBody !== undefined
  ) {
    const secret = decryptAes(
      webhook.signingSecret,
      "aes-256-cbc",
      webhook.signingSecretKeyVersion ?? 1
    ).value;
    Object.assign(headers, buildSignatureHeaders(secret, rawBody));
  }

  try {
    // SSRF guard: the webhook URL is operator/tenant supplied; ensure it cannot
    // be used to reach internal services or the cloud metadata endpoint.
    const response = await fetchWithSsrfGuard(webhook.webhookUrl, {
      method: webhook.method,
      headers,
      body: rawBody,
    });

    if (!response.ok) {
      throw new WebhookTriggerError(
        `Webhook request failed with status ${response.status}`,
        response.status
      );
    }

    return {
      success: true,
      statusCode: response.status,
      response: await response.json().catch(() => null),
    };
  } catch (error) {
    if (error instanceof WebhookTriggerError) {
      throw error;
    }
    if (error instanceof SsrfBlockedError) {
      throw new WebhookTriggerError(
        `Webhook URL is not allowed: ${error.message}`,
        400
      );
    }
    throw new WebhookTriggerError(
      `Failed to trigger webhook: ${error + ""}`,
      500
    );
  }
};
