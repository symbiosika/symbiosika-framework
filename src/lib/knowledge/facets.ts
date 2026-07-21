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

import { sql, type SQL } from "drizzle-orm";
import { knowledgeText, type KnowledgeTextInsert } from "../db/schema/knowledge";
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
  const settingAttributes =
    "attributes" in data &&
    data.attributes != null &&
    Object.keys(data.attributes).length > 0;
  if (!settingType && !settingStatus && !settingAttributes) return;

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

  if (settingAttributes) {
    const definitions = new Map(config.attributes.map((d) => [d.key, d]));
    for (const [key, value] of Object.entries(
      data.attributes as Record<string, unknown>
    )) {
      const definition = definitions.get(key);
      if (!definition) {
        const allowed = [...definitions.keys()];
        throw new FacetValidationError(
          `Unknown attribute key "${key}". ` +
            (allowed.length > 0
              ? `Allowed keys: ${allowed.join(", ")}`
              : "This tenant has no attribute keys configured.")
        );
      }
      if (typeof value !== "string" || value.length === 0) {
        throw new FacetValidationError(
          `Attribute "${key}" must have a non-empty string value.`
        );
      }
      if (definition.values && !definition.values.includes(value)) {
        throw new FacetValidationError(
          `Invalid value "${value}" for attribute "${key}". Allowed: ${definition.values.join(", ")}`
        );
      }
    }
  }
};

/** Facet filter parameters accepted by list/search/recent-changes queries. */
export interface FacetFilters {
  pageType?: string;
  status?: string;
  /**
   * Attribute equality filters, combined with AND:
   * `{ hersteller: "Miele", typ: "Datenblatt" }` matches pages carrying both.
   */
  attributes?: Record<string, string>;
}

/**
 * SQL condition for an attribute filter: jsonb containment over the
 * `attributes` column, served by the GIN index knowledge_text_attributes_idx.
 * Returns undefined when the filter is empty.
 */
export const attributesContainCondition = (
  attributes?: Record<string, string>
): SQL | undefined => {
  if (!attributes || Object.keys(attributes).length === 0) return undefined;
  return sql`${knowledgeText.attributes} @> ${JSON.stringify(attributes)}::jsonb`;
};
