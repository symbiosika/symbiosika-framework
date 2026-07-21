/**
 * Per-tenant knowledge configuration, persisted via the tenant-specific-data
 * store (`specific-data`) under the "knowledge" key. Currently the auto-summary
 * switch and the controlled facet vocabularies, extensible for future settings.
 *
 * The auto-summary switch is the tenant-level control: even with a global LLM
 * configured (AI_PROVIDER != none), a tenant can turn auto-summaries off as a
 * cost/privacy decision. When off, everything else keeps working — lists just
 * carry whatever manual summaries exist.
 */

import {
  getOrganisationSpecificData,
  createOrganisationSpecificData,
  updateOrganisationSpecificData,
} from "../specific-data";

const KNOWLEDGE_CONFIG_KEY = "knowledge";

/**
 * Definition of one catalog attribute key a tenant allows on its knowledge
 * pages (e.g. "typ", "hersteller"). When `values` is set the attribute is a
 * closed list (like pageType); when omitted, any non-empty string value is
 * accepted for the key.
 */
export interface KnowledgeAttributeDefinition {
  key: string;
  /** Display label for UIs; falls back to the key. */
  label?: string;
  /** Optional closed value list. Free-form values when omitted. */
  values?: string[];
}

export interface KnowledgeTenantConfig {
  /**
   * Whether pages in `auto` summary mode are (re)generated in the background.
   * Default true — but generation additionally requires a global LLM
   * (`isAiEnabled()`), so this only has effect when an AI provider is set.
   */
  autoSummaries: boolean;
  /**
   * Controlled vocabulary for the `pageType` facet (closed list). Writes that
   * set a page type outside this list are rejected.
   */
  pageTypes: string[];
  /**
   * Controlled vocabulary for the `status` facet (closed list).
   */
  statuses: string[];
  /**
   * Catalog attribute keys allowed on knowledge pages. Writes that set an
   * attribute key outside this list (or a value outside a key's closed value
   * list) are rejected. Default: none — attributes are opt-in per tenant.
   */
  attributes: KnowledgeAttributeDefinition[];
}

/** Default facet vocabularies. Tenants may override them via the config. */
export const DEFAULT_PAGE_TYPES = ["FAQ", "manual", "text", "policy", "note"];
export const DEFAULT_STATUSES = ["draft", "verified", "outdated"];

const DEFAULT_KNOWLEDGE_TENANT_CONFIG: KnowledgeTenantConfig = {
  autoSummaries: true,
  pageTypes: DEFAULT_PAGE_TYPES,
  statuses: DEFAULT_STATUSES,
  attributes: [],
};

/** Read a tenant's knowledge config, merged over the defaults. */
export const getKnowledgeTenantConfig = async (
  tenantId: string
): Promise<KnowledgeTenantConfig> => {
  let stored: Partial<KnowledgeTenantConfig> = {};
  try {
    const row = await getOrganisationSpecificData(
      tenantId,
      KNOWLEDGE_CONFIG_KEY
    );
    stored = (row.data ?? {}) as Partial<KnowledgeTenantConfig>;
  } catch {
    // no config stored yet → defaults
  }
  return { ...DEFAULT_KNOWLEDGE_TENANT_CONFIG, ...stored };
};

/** Upsert (patch) a tenant's knowledge config. */
export const setKnowledgeTenantConfig = async (
  tenantId: string,
  patch: Partial<KnowledgeTenantConfig>
): Promise<KnowledgeTenantConfig> => {
  const current = await getKnowledgeTenantConfig(tenantId);
  const next = { ...current, ...patch };
  try {
    await getOrganisationSpecificData(tenantId, KNOWLEDGE_CONFIG_KEY);
    await updateOrganisationSpecificData(tenantId, KNOWLEDGE_CONFIG_KEY, {
      data: next,
    });
  } catch {
    await createOrganisationSpecificData({
      tenantId,
      key: KNOWLEDGE_CONFIG_KEY,
      data: next,
    });
  }
  return next;
};
