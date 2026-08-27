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

/**
 * Presentation for one page type — icon, colour and display label. Purely
 * cosmetic: it never gates a write, and a page type works without one.
 *
 * Kept in a separate map (keyed by page type) instead of enriching the
 * `pageTypes` vocabulary itself, so facet validation, the MCP surface and
 * every existing `pageTypes` consumer keep seeing a plain `string[]`.
 *
 * **`icon` and `color` are opaque client tokens.** The framework stores and
 * returns them without interpreting either, because which icons and which
 * colours exist is a property of the consuming app's design system, not of the
 * framework: one app may use Material icon names and Tailwind palette keys,
 * another emoji and hex values, a third its own brand tokens. A client is
 * expected to resolve a value it knows and render nothing (or a neutral
 * default) for one it does not, so a config written by a newer or different
 * client never breaks an older one.
 *
 * Consequently a client must treat `color` as a token to look up, never as a
 * string to interpolate into CSS.
 */
export interface KnowledgePageTypeStyle {
  /** Icon token — e.g. an emoji or an icon name the client knows. */
  icon?: string;
  /** Colour token the client resolves against its own palette. */
  color?: string;
  /** Display label; falls back to the page type key itself. */
  label?: string;
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
   * Presentation per page type, keyed by the page type as it appears in
   * `pageTypes`. Additive and optional — entries for page types that no longer
   * exist are ignored on read and pruned when the config is saved.
   */
  pageTypeStyles: Record<string, KnowledgePageTypeStyle>;
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
  pageTypeStyles: {},
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
    stored = (row?.data ?? {}) as Partial<KnowledgeTenantConfig>;
  } catch {
    // no config stored yet → defaults
  }
  return { ...DEFAULT_KNOWLEDGE_TENANT_CONFIG, ...stored };
};

/**
 * Drop presentation entries whose page type is no longer part of the
 * vocabulary, so removing a page type does not leave its icon/colour behind to
 * reappear when the same name is added again later.
 */
const prunePageTypeStyles = (
  pageTypes: string[],
  styles: Record<string, KnowledgePageTypeStyle> | undefined
): Record<string, KnowledgePageTypeStyle> => {
  if (!styles) return {};
  const allowed = new Set(pageTypes);
  return Object.fromEntries(
    Object.entries(styles).filter(([key]) => allowed.has(key))
  );
};

/** Upsert (patch) a tenant's knowledge config. */
export const setKnowledgeTenantConfig = async (
  tenantId: string,
  patch: Partial<KnowledgeTenantConfig>
): Promise<KnowledgeTenantConfig> => {
  const current = await getKnowledgeTenantConfig(tenantId);
  const merged = { ...current, ...patch };
  const next = {
    ...merged,
    pageTypeStyles: prunePageTypeStyles(merged.pageTypes, merged.pageTypeStyles),
  };
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
