/**
 * Generic accessor for the `server_settings` key/value table.
 *
 * This is the framework's small, global (not tenant-scoped) runtime config
 * store — the "GLOBAL_CONFIG". Values are persisted as strings under a unique
 * `key`. Use it for operator-tunable settings that should be changeable without
 * a redeploy (unlike env vars, which are deploy-time).
 *
 * Values are cached in memory for a short TTL so hot paths (e.g. a per-minute
 * sweeper reading the same key) don't hit the DB every call. Writes update the
 * cache immediately.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/db-connection";
import { serverSettings } from "../db/schema/server";
import log from "../log";

/** Known, framework-owned setting keys. Consumers may use their own keys too. */
export const SERVER_SETTING_KEYS = {
  /** License blob (owned by the license service). */
  LICENSE: "LICENSE",
  /**
   * Quiet period in minutes a wiki page must be unedited before its summary is
   * (re)generated. Overrides the built-in default. See B1 page summaries.
   */
  WIKI_SUMMARY_DEBOUNCE_MINUTES: "WIKI_SUMMARY_DEBOUNCE_MINUTES",
} as const;

const CACHE_TTL_MS = 30_000;

type CacheEntry = { value: string | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();

const now = () => Date.now();

/**
 * Get a raw string setting value, or `null` if unset.
 * Cached for a short TTL. Pass `{ fresh: true }` to bypass the cache.
 */
export const getServerSetting = async (
  key: string,
  options?: { fresh?: boolean }
): Promise<string | null> => {
  if (!options?.fresh) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
  }

  const result = await getDb()
    .select({ value: serverSettings.value })
    .from(serverSettings)
    .where(eq(serverSettings.key, key))
    .limit(1);

  const value = result[0]?.value ?? null;
  cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
  return value;
};

/**
 * Get a setting parsed as an integer, falling back to `fallback` when unset or
 * not a valid finite integer.
 */
export const getServerSettingInt = async (
  key: string,
  fallback: number,
  options?: { fresh?: boolean }
): Promise<number> => {
  const raw = await getServerSetting(key, options);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    log.error(
      `server_settings["${key}"]="${raw}" is not a valid integer; using ${fallback}.`
    );
    return fallback;
  }
  return parsed;
};

/**
 * Get a setting parsed as a boolean (`"true"`/`"1"` → true), falling back when
 * unset.
 */
export const getServerSettingBool = async (
  key: string,
  fallback: boolean,
  options?: { fresh?: boolean }
): Promise<boolean> => {
  const raw = await getServerSetting(key, options);
  if (raw === null) return fallback;
  return raw === "true" || raw === "1";
};

/** Upsert a raw string setting value. Updates the cache immediately. */
export const setServerSetting = async (
  key: string,
  value: string
): Promise<void> => {
  await getDb()
    .insert(serverSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: [serverSettings.key],
      set: { value, updatedAt: new Date().toISOString() },
    });
  cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
};

/** Delete a setting. Clears it from the cache. */
export const deleteServerSetting = async (key: string): Promise<void> => {
  await getDb().delete(serverSettings).where(eq(serverSettings.key, key));
  cache.delete(key);
};

/** Clear the in-memory cache (useful in tests). */
export const clearServerSettingsCache = (): void => cache.clear();
