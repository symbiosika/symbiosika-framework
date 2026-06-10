import { and, eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import type { WebhookInsert, WebhookSelect } from "../db/schema/webhooks";
import { webhooks } from "../db/schema/webhooks";

/**
 * Returns the webhook only if it belongs to the given tenant. All by-id
 * operations go through this so a webhook of another tenant cannot be read,
 * modified, or deleted by guessing its id (IDOR — webhook rows hold the target
 * URL and custom headers).
 */
const getWebhookForTenant = async (
  id: string,
  tenantId: string
): Promise<WebhookSelect | undefined> => {
  return await getDb().query.webhooks.findFirst({
    where: and(eq(webhooks.id, id), eq(webhooks.tenantId, tenantId)),
  });
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
  if (!webhook) {
    throw new Error("Failed to create webhook");
  }
  return webhook;
};

/**
 * Get webhook by its ID, scoped to the tenant.
 */
export const getWebhookById = async (
  id: string,
  userId: string,
  tenantId: string
) => {
  return await getWebhookForTenant(id, tenantId);
};

/**
 * Get all webhooks accessible by user
 * Filters by personal webhooks and team webhooks the user is part of
 */
export const getAllUsersWebhooks = async (
  userId: string,
  tenantId: string
) => {
  return await getDb().query.webhooks.findMany({
    where: and(
      eq(webhooks.userId, userId),
      eq(webhooks.tenantId, tenantId)
    ),
    orderBy: (webhooks) => webhooks.name,
  });
};

/**
 * Get all webhooks for an tenant
 */
export const getAllOrganisationWebhooks = async (tenantId: string) => {
  return await getDb().query.webhooks.findMany({
    where: eq(webhooks.tenantId, tenantId),
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
  userId: string,
  tenantId: string
) => {
  const existing = await getWebhookForTenant(id, tenantId);
  if (!existing) {
    throw new Error("Webhook not found");
  }
  const [updated] = await getDb()
    .update(webhooks)
    .set({
      ...input,
      // never allow moving a webhook to another tenant via the update payload
      tenantId,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(webhooks.id, id), eq(webhooks.tenantId, tenantId)))
    .returning();

  return updated;
};

/**
 * Delete a webhook by its ID
 * will check if user has access to webhook
 */
export const deleteWebhook = async (
  id: string,
  userId: string,
  tenantId: string
) => {
  await getDb()
    .delete(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.tenantId, tenantId)));
};
