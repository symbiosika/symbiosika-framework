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
}

/** Default facet vocabularies. Tenants may override them via the config. */
export const DEFAULT_PAGE_TYPES = ["FAQ", "manual", "text", "policy", "note"];
export const DEFAULT_STATUSES = ["draft", "verified", "outdated"];

const DEFAULT_KNOWLEDGE_TENANT_CONFIG: KnowledgeTenantConfig = {
  autoSummaries: true,
  pageTypes: DEFAULT_PAGE_TYPES,
  statuses: DEFAULT_STATUSES,
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
