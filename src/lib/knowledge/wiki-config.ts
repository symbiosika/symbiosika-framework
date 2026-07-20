/**
 * Per-tenant wiki configuration, stored in the `tenant_specific_data` k/v table
 * under the "wiki" key. Currently the auto-summary switch (B1), extensible for
 * future wiki-level toggles.
 *
 * This is the tenant-level control from the plan: even with a global LLM
 * configured (AI_PROVIDER != none), a tenant can turn auto-summaries off as a
 * cost/privacy decision. When off, everything else keeps working — lists just
 * carry whatever manual summaries exist.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { tenantSpecificData } from "../db/schema/additional-data";

const WIKI_CONFIG_KEY = "wiki";

export interface WikiTenantConfig {
  /**
   * Whether pages in `auto` summary mode are (re)generated in the background.
   * Default true — but generation additionally requires a global LLM
   * (`isAiEnabled()`), so this only has effect when an AI provider is set.
   */
  autoSummaries: boolean;
  /**
   * B3 controlled vocabulary for the `pageType` facet (closed list). Writes
   * that set a page type outside this list are rejected.
   */
  pageTypes: string[];
  /**
   * B3 controlled vocabulary for the `status` facet (closed list).
   */
  statuses: string[];
}

/** Default facet vocabularies (German, matching the plan's examples). */
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
  const rows = await getDb()
    .select({ data: tenantSpecificData.data })
    .from(tenantSpecificData)
    .where(
      and(
        eq(tenantSpecificData.tenantId, tenantId),
        eq(tenantSpecificData.key, WIKI_CONFIG_KEY)
      )
    )
    .limit(1);

  const stored = (rows[0]?.data ?? {}) as Partial<WikiTenantConfig>;
  return { ...DEFAULT_WIKI_TENANT_CONFIG, ...stored };
};

/** Upsert (patch) a tenant's wiki config. */
export const setWikiTenantConfig = async (
  tenantId: string,
  patch: Partial<WikiTenantConfig>
): Promise<WikiTenantConfig> => {
  const current = await getWikiTenantConfig(tenantId);
  const next = { ...current, ...patch };
  await getDb()
    .insert(tenantSpecificData)
    .values({ tenantId, key: WIKI_CONFIG_KEY, data: next })
    .onConflictDoUpdate({
      target: [tenantSpecificData.tenantId, tenantSpecificData.key],
      set: { data: next, updatedAt: new Date().toISOString() },
    });
  return next;
};
