/**
 * Per-tenant wiki configuration, persisted via the tenant-specific-data store
 * (`specific-data`) under the "wiki" key. Currently the auto-summary switch and
 * the controlled facet vocabularies, extensible for future wiki-level settings.
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

const WIKI_CONFIG_KEY = "wiki";

export interface WikiTenantConfig {
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

/** Default facet vocabularies. */
export const DEFAULT_PAGE_TYPES = [
  "anleitung",
  "konzept",
  "policy",
  "meeting-notiz",
  "referenz",
];
export const DEFAULT_STATUSES = ["entwurf", "verifiziert", "veraltet"];

const DEFAULT_WIKI_TENANT_CONFIG: WikiTenantConfig = {
  autoSummaries: true,
  pageTypes: DEFAULT_PAGE_TYPES,
  statuses: DEFAULT_STATUSES,
};

/** Read a tenant's wiki config, merged over the defaults. */
export const getWikiTenantConfig = async (
  tenantId: string
): Promise<WikiTenantConfig> => {
  let stored: Partial<WikiTenantConfig> = {};
  try {
    const row = await getOrganisationSpecificData(tenantId, WIKI_CONFIG_KEY);
    stored = (row.data ?? {}) as Partial<WikiTenantConfig>;
  } catch {
    // no config stored yet → defaults
  }
  return { ...DEFAULT_WIKI_TENANT_CONFIG, ...stored };
};

/** Upsert (patch) a tenant's wiki config. */
export const setWikiTenantConfig = async (
  tenantId: string,
  patch: Partial<WikiTenantConfig>
): Promise<WikiTenantConfig> => {
  const current = await getWikiTenantConfig(tenantId);
  const next = { ...current, ...patch };
  try {
    await getOrganisationSpecificData(tenantId, WIKI_CONFIG_KEY);
    await updateOrganisationSpecificData(tenantId, WIKI_CONFIG_KEY, {
      data: next,
    });
  } catch {
    await createOrganisationSpecificData({
      tenantId,
      key: WIKI_CONFIG_KEY,
      data: next,
    });
  }
  return next;
};
