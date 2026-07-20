/**
 * Controlled facets for knowledge pages.
 *
 * Facets are first-class columns on knowledgeText (pageType, status, owner,
 * validUntil, supersedes) drawn from a small controlled vocabulary configured
 * per tenant (see knowledge-config.ts) — deliberately NOT a free-tag system. They
 * are delivered in every list-type response (automatic, since list queries
 * select all columns except `text`) and usable as filter parameters.
 *
 * This module validates facet writes against the tenant vocabulary. It is
 * called from the knowledgeText create/update paths so any write route is
 * covered.
 */

import type { KnowledgeTextInsert } from "../db/schema/knowledge";
import { getKnowledgeTenantConfig } from "./knowledge-config";

/** Error thrown when a facet value is outside the tenant's controlled list. */
export class FacetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacetValidationError";
  }
}

const isSet = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

/**
 * Validate the facet fields present on a write against the tenant's controlled
 * vocabulary. No-op when no controlled facet is being set. `null`/empty clears
 * a facet and is always allowed.
 */
export const validateFacetsForWrite = async (
  tenantId: string,
  data: Partial<KnowledgeTextInsert>
): Promise<void> => {
  const settingType = "pageType" in data && isSet(data.pageType);
  const settingStatus = "status" in data && isSet(data.status);
  if (!settingType && !settingStatus) return;

  const config = await getKnowledgeTenantConfig(tenantId);

  if (settingType && !config.pageTypes.includes(data.pageType as string)) {
    throw new FacetValidationError(
      `Invalid page type "${data.pageType}". Allowed: ${config.pageTypes.join(
        ", "
      )}`
    );
  }
  if (settingStatus && !config.statuses.includes(data.status as string)) {
    throw new FacetValidationError(
      `Invalid status "${data.status}". Allowed: ${config.statuses.join(", ")}`
    );
  }
};

/** Facet filter parameters accepted by list/search/recent-changes queries. */
export interface FacetFilters {
  pageType?: string;
  status?: string;
}
