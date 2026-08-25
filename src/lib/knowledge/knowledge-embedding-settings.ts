/**
 * Organisation-wide embedding switch.
 *
 * Whether wiki pages are mirrored into the RAG pipeline is a TENANT decision,
 * never a per-page one: one toggle in the organisation settings decides it for
 * every page of that tenant. `knowledge_text.embedding_enabled` is therefore
 * derived state — it is written from this setting on every create/update (see
 * `knowledge-texts.ts`) and re-checked by the embedding sync itself, so no
 * write path — REST API, web UI, MCP, file/URL import or source sync — can put
 * a single page out of line with its organisation.
 *
 * The setting lives in `tenant_settings` under the key `knowledgeEmbedding`
 * (`valueJson: { enabled: boolean }`), the same store the branding colours
 * use. Missing row → disabled, which preserves the historical default.
 */

import { and, eq, isNotNull, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { tenantSettings } from "../db/schema/tenant-settings";
import { knowledgeText, knowledgeEntry } from "../db/schema/knowledge";
import {
  DEFAULT_EMBEDDING_PROVIDER,
  EMBEDDING_PROVIDER,
  type EmbeddingProviderId,
} from "../ai/types";
import { isEmbeddingProviderConfigured } from "../ai/providers";
import { getConfiguredEmbeddingModelId } from "./embedding";
import { countKnowledgeTextsNeedingEmbedding } from "./knowledge-text-embedding-backfill";
import log from "../log";

/** `tenant_settings.key` the organisation-wide embedding switch is stored under. */
export const KNOWLEDGE_EMBEDDING_SETTING_KEY = "knowledgeEmbedding";

export type KnowledgeEmbeddingSetting = {
  /** Mirror every page of this tenant into the RAG pipeline. */
  enabled: boolean;
};

/**
 * Is embedding switched on for this organisation? Defaults to `false` when the
 * setting was never written.
 */
export const getTenantEmbeddingEnabled = async (
  tenantId: string
): Promise<boolean> => {
  const rows = await getDb()
    .select({ valueJson: tenantSettings.valueJson })
    .from(tenantSettings)
    .where(
      and(
        eq(tenantSettings.tenantId, tenantId),
        eq(tenantSettings.key, KNOWLEDGE_EMBEDDING_SETTING_KEY)
      )
    )
    .limit(1);

  return (rows[0]?.valueJson as KnowledgeEmbeddingSetting | undefined)
    ?.enabled === true;
};

/**
 * Same as `getTenantEmbeddingEnabled`, but never throws — used on write paths
 * where a settings-read hiccup must not fail the page write. Falls back to the
 * value already stored on the page (or `false`).
 */
export const getTenantEmbeddingEnabledSafe = async (
  tenantId: string,
  fallback = false
): Promise<boolean> => {
  try {
    return await getTenantEmbeddingEnabled(tenantId);
  } catch (e) {
    log.error(`Failed to read the tenant embedding setting: ${e}`);
    return fallback;
  }
};

/** What the deployment offers for embeddings, for the settings UI. */
export type EmbeddingProviderStatus = {
  /** Provider selected via `EMBEDDING_PROVIDER` (default: mistral). */
  provider: EmbeddingProviderId;
  /** True when the provider's API key is present. */
  configured: boolean;
  /** Model new embeddings would use, or null when not configured. */
  model: string | null;
  /** Env var that has to be set for this provider (for the UI hint). */
  requiredEnvVar: string | null;
};

/** Env var carrying the API key of an embedding provider. */
const REQUIRED_ENV_VAR: Record<string, string> = {
  [EMBEDDING_PROVIDER.MISTRAL]: "MISTRAL_API_KEY",
  [EMBEDDING_PROVIDER.OPENROUTER]: "OPENROUTER_API_KEY",
};

/**
 * Whether this deployment can embed at all. Read-only; the UI shows it next to
 * the switch so an admin sees *why* nothing gets indexed when the API key is
 * missing, instead of silently enabling a feature that cannot run.
 */
export const getEmbeddingProviderStatus = (): EmbeddingProviderStatus => {
  const provider =
    (process.env.EMBEDDING_PROVIDER as EmbeddingProviderId) ??
    DEFAULT_EMBEDDING_PROVIDER;
  const configured = isEmbeddingProviderConfigured(provider);
  return {
    provider,
    configured,
    model: configured ? getConfiguredEmbeddingModelId() : null,
    requiredEnvVar: REQUIRED_ENV_VAR[provider] ?? null,
  };
};

export type KnowledgeEmbeddingSettingsState = KnowledgeEmbeddingSetting & {
  provider: EmbeddingProviderStatus;
  /**
   * Pages that are marked for embedding but have no vectors yet — what the
   * backfill would work off. 0 while the switch is off.
   */
  pendingPages: number;
};

/** The switch, the provider status and the backfill backlog, for the UI. */
export const getKnowledgeEmbeddingSettings = async (
  tenantId: string
): Promise<KnowledgeEmbeddingSettingsState> => ({
  enabled: await getTenantEmbeddingEnabled(tenantId),
  provider: getEmbeddingProviderStatus(),
  pendingPages: await countKnowledgeTextsNeedingEmbedding(tenantId),
});

export type SetKnowledgeEmbeddingResult = KnowledgeEmbeddingSettingsState & {
  /** Pages whose derived `embeddingEnabled` flag was flipped by this change. */
  pagesUpdated: number;
  /** RAG mirrors removed (only when switching the setting off). */
  mirrorsRemoved: number;
};

/**
 * Flip the organisation-wide switch.
 *
 * Besides storing the setting this reconciles the derived flag on every page of
 * the tenant in a single statement, so the stored rows never disagree with the
 * organisation's setting.
 *
 * - switching ON  → pages are marked for embedding; the vectors themselves are
 *   produced by the regular sync the next time a page is saved (embedding all
 *   existing content at once would be a long-running, paid operation, so it is
 *   deliberately not done inside this request).
 * - switching OFF → the RAG mirrors are deleted right away (chunks go with them
 *   via the FK cascade), so disabling actually removes the content from
 *   semantic search instead of leaving stale vectors behind.
 */
export const setTenantEmbeddingEnabled = async (
  tenantId: string,
  enabled: boolean
): Promise<SetKnowledgeEmbeddingResult> => {
  const db = getDb();

  await db
    .insert(tenantSettings)
    .values({
      tenantId,
      key: KNOWLEDGE_EMBEDDING_SETTING_KEY,
      valueJson: { enabled } satisfies KnowledgeEmbeddingSetting,
      description:
        "Mirror all wiki pages of this organisation into the semantic (RAG) index",
    })
    .onConflictDoUpdate({
      target: [tenantSettings.tenantId, tenantSettings.key],
      set: {
        valueJson: { enabled } satisfies KnowledgeEmbeddingSetting,
        updatedAt: sql`now()`,
      },
    });

  // Reconcile the derived per-page flag for the whole tenant.
  const flipped = await db
    .update(knowledgeText)
    .set({ embeddingEnabled: enabled })
    .where(
      and(
        eq(knowledgeText.tenantId, tenantId),
        eq(knowledgeText.embeddingEnabled, !enabled)
      )
    )
    .returning({ id: knowledgeText.id });

  let mirrorsRemoved = 0;
  if (!enabled) {
    mirrorsRemoved = await removeAllKnowledgeTextMirrors(tenantId);
  }

  log.debug(
    `Tenant ${tenantId}: embedding ${enabled ? "enabled" : "disabled"} ` +
      `(${flipped.length} page(s) reconciled, ${mirrorsRemoved} mirror(s) removed)`
  );

  return {
    enabled,
    provider: getEmbeddingProviderStatus(),
    pendingPages: await countKnowledgeTextsNeedingEmbedding(tenantId),
    pagesUpdated: flipped.length,
    mirrorsRemoved,
  };
};

/**
 * Drop every RAG mirror created from a wiki page of this tenant and clear the
 * links + content hashes, so a later re-enable starts from a clean slate.
 * Chunks are removed by the FK cascade on `knowledge_chunks`.
 */
const removeAllKnowledgeTextMirrors = async (
  tenantId: string
): Promise<number> => {
  const db = getDb();
  const linked = await db
    .select({
      id: knowledgeText.id,
      knowledgeEntryId: knowledgeText.knowledgeEntryId,
    })
    .from(knowledgeText)
    .where(
      and(
        eq(knowledgeText.tenantId, tenantId),
        isNotNull(knowledgeText.knowledgeEntryId)
      )
    );
  if (linked.length === 0) return 0;

  const entryIds = linked
    .map((row) => row.knowledgeEntryId)
    .filter((id): id is string => !!id);

  await db
    .delete(knowledgeEntry)
    .where(
      and(
        eq(knowledgeEntry.tenantId, tenantId),
        inArray(knowledgeEntry.id, entryIds)
      )
    );

  // the FK is ON DELETE SET NULL, but the stale content hash has to go too —
  // otherwise a re-enable would consider the pages "already embedded".
  await db
    .update(knowledgeText)
    .set({
      knowledgeEntryId: null,
      meta: sql`${knowledgeText.meta} - 'embeddingContentHash'`,
    })
    .where(
      and(
        eq(knowledgeText.tenantId, tenantId),
        inArray(
          knowledgeText.id,
          linked.map((row) => row.id)
        )
      )
    );

  return entryIds.length;
};
