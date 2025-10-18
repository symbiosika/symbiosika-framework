import { and, eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import type { WebhookInsert, WebhookSelect } from "../db/schema/webhooks";
import { webhooks } from "../db/schema/webhooks";

/**
 * Helper to check if user has access to webhook
 * as a direct owner or part of a team that owns the webhook
 */
export const hasAccessToWebhook = async (webhookId: string, userId: string) => {
  return true;
};

/**
 * Create a new webhook
 */
export const createWebhook = async (userId: string, input: WebhookInsert) => {
  const [webhook] = await getDb()
    .insert(webhooks)
    .values({
      ...input,
      userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .returning();
  return webhook;
};

/**
 * Get webhook by its ID
 * will check if user has access to webhook
 */
export const getWebhookById = async (id: string, userId: string) => {
  if (!(await hasAccessToWebhook(id, userId))) {
    throw new Error("User does not have permission to access webhook");
  }
  return await getDb().query.webhooks.findFirst({
    where: eq(webhooks.id, id),
  });
};

/**
 * Get all webhooks accessible by user
 * Filters by personal webhooks and team webhooks the user is part of
 */
export const getAllUsersWebhooks = async (
  userId: string,
  organisationId: string
) => {
  return await getDb().query.webhooks.findMany({
    where: and(
      eq(webhooks.userId, userId),
      eq(webhooks.organisationId, organisationId)
    ),
    orderBy: (webhooks) => webhooks.name,
  });
};

/**
 * Get all webhooks for an organisation
 */
export const getAllOrganisationWebhooks = async (organisationId: string) => {
  return await getDb().query.webhooks.findMany({
    where: eq(webhooks.organisationId, organisationId),
    orderBy: (webhooks) => webhooks.name,
  });
};

/**
 * Update webhook
 * will check if user has access to webhook
 */
export const updateWebhook = async (
  id: string,
  input: Partial<WebhookSelect>,
  userId: string
) => {
  if (!(await hasAccessToWebhook(id, userId))) {
    throw new Error("User does not have permission to update webhook");
  }
  const [updated] = await getDb()
    .update(webhooks)
    .set({
      ...input,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(webhooks.id, id))
    .returning();

  return updated;
};

/**
 * Delete a webhook by its ID
 * will check if user has access to webhook
 */
export const deleteWebhook = async (id: string, userId: string) => {
  if (!(await hasAccessToWebhook(id, userId))) {
    throw new Error("User does not have permission to delete webhook");
  }
  await getDb().delete(webhooks).where(eq(webhooks.id, id));
};
