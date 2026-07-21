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
import type { ExtractionTarget } from "./parsing/pdf/types";

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
  /**
   * Instruction handed to the parsing service's extractor ("what exactly to
   * extract"). Only used when parser-side attribute extraction is enabled
   * (`enablePdfParserExtraction`). Falls back to the label/key.
   */
  description?: string;
  /**
   * Data type hint for the extractor. Defaults to "enum" when `values` is set,
   * otherwise "string".
   */
  type?: "string" | "number" | "date" | "boolean" | "enum";
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

/**
 * Map a tenant's catalog attribute definitions onto structured extraction
 * targets for the parsing service. Each attribute becomes one field the
 * extractor should try to fill from the document:
 *   - `key`         → target key (verbatim, used back as the metadata key)
 *   - `label ?? key`→ human-readable field name
 *   - `description ?? label ?? key` → extractor instruction
 *   - `type`        → explicit hint, else "enum" when a closed value list
 *                     exists, else "string"
 *   - `values`      → enum options (only meaningful for `type: "enum"`)
 */
export const attributeDefinitionsToExtractionTargets = (
  definitions: KnowledgeAttributeDefinition[]
): ExtractionTarget[] =>
  definitions.map((d) => {
    const type = d.type ?? (d.values && d.values.length > 0 ? "enum" : "string");
    return {
      key: d.key,
      name: d.label ?? d.key,
      description: d.description ?? d.label ?? d.key,
      type,
      ...(type === "enum" && d.values ? { options: d.values } : {}),
    };
  });

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
