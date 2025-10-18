import { getDb } from "../db/db-connection";
import { webhooks } from "../db/schema/webhooks";
import { and, eq } from "drizzle-orm";

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
 * Trigger a webhook by its ID
 */
export const triggerWebhook = async (
  webhookId: string,
  organisationId: string,
  options: WebhookTriggerOptions = {}
) => {
  // Get webhook details
  const webhook = await getDb().query.webhooks.findFirst({
    where: and(
      eq(webhooks.id, webhookId),
      eq(webhooks.organisationId, organisationId),
      eq(webhooks.event, "chat-output")
    ),
  });

  if (!webhook) {
    throw new WebhookTriggerError("Webhook not found", 404);
  }

  // Prepare headers
  const headers = {
    "Content-Type": "application/json",
    ...(webhook.headers || {}),
    ...(options.headers || {}),
  };

  try {
    // Make the request
    const response = await fetch(webhook.webhookUrl, {
      method: webhook.method,
      headers,
      body:
        webhook.method !== "GET"
          ? JSON.stringify(options.payload || {})
          : undefined,
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
    throw new WebhookTriggerError(
      `Failed to trigger webhook: ${error + ""}`,
      500
    );
  }
};
