import { redis, RedisClient } from "bun";
import * as crypto from "crypto";
import log from "../log";

// Cache TTL: 1 hour (3600 seconds)
const CACHE_TTL_SECONDS = 3600;

// Fallback in-memory cache if Redis is not available
const FALLBACK_CACHE = new Map<
  string,
  { usersEmail: string; usersId: string; scopes?: string[]; expiresAt: number }
>();

let redisClient: RedisClient | null = null;
let redisAvailable = false;

/**
 * Initialize Redis client
 * Falls back to in-memory cache if Redis is not available
 */
export function initRedisCache(): void {
  try {
    const redisUrl =
      process.env.REDIS_URL ||
      process.env.VALKEY_URL ||
      "redis://localhost:6379";

    // Try to create a Redis client
    redisClient = new RedisClient(redisUrl, {
      connectionTimeout: 5000,
      autoReconnect: true,
      maxRetries: 3,
    });

    // Test connection by trying to ping
    redisClient
      .ping()
      .then(() => {
        redisAvailable = true;
        log.info("Redis cache initialized successfully");
      })
      .catch((error) => {
        log.debug("Redis not available, falling back to in-memory cache", {
          error,
        });
        redisAvailable = false;
        redisClient = null;
      });
  } catch (error) {
    log.debug("Failed to initialize Redis, falling back to in-memory cache", {
      error,
    });
    redisAvailable = false;
    redisClient = null;
  }
}

/**
 * Generate a cache key from token
 * Uses SHA-256 hash for security (don't store raw tokens)
 */
function getCacheKey(token: string): string {
  return `jwt:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Get cached token validation result
 */
export async function getCachedToken(
  token: string
): Promise<{ usersEmail: string; usersId: string; scopes?: string[] } | null> {
  const cacheKey = getCacheKey(token);

  // Try Redis first
  if (redisAvailable && redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as {
          usersEmail: string;
          usersId: string;
          scopes?: string[];
        };
        // log.debug("Token found in Redis cache");
        return parsed;
      }
    } catch (error) {
      log.debug("Redis get error, falling back to in-memory cache", { error });
      redisAvailable = false;
    }
  }

  // Fallback to in-memory cache
  const cached = FALLBACK_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    //log.debug("Token found in fallback cache");
    return {
      usersEmail: cached.usersEmail,
      usersId: cached.usersId,
      scopes: cached.scopes,
    };
  }

  // Clean up expired entries from fallback cache
  if (cached && cached.expiresAt <= Date.now()) {
    FALLBACK_CACHE.delete(cacheKey);
  }

  return null;
}

/**
 * Set cached token validation result
 */
export async function setCachedToken(
  token: string,
  data: { usersEmail: string; usersId: string; scopes?: string[] }
): Promise<void> {
  const cacheKey = getCacheKey(token);
  const cacheValue = JSON.stringify(data);

  // Try Redis first
  if (redisAvailable && redisClient) {
    try {
      await redisClient.set(cacheKey, cacheValue);
      await redisClient.expire(cacheKey, CACHE_TTL_SECONDS);
      log.debug("Token cached in Redis");
      return;
    } catch (error) {
      log.debug("Redis set error, falling back to in-memory cache", { error });
      redisAvailable = false;
    }
  }

  // Fallback to in-memory cache
  const expiresAt = Date.now() + CACHE_TTL_SECONDS * 1000;
  FALLBACK_CACHE.set(cacheKey, {
    ...data,
    expiresAt,
  });
  log.debug("Token cached in fallback cache");
}

/**
 * Delete cached token (e.g., on logout or token revocation)
 */
export async function deleteCachedToken(token: string): Promise<void> {
  const cacheKey = getCacheKey(token);

  // Try Redis first
  if (redisAvailable && redisClient) {
    try {
      await redisClient.del(cacheKey);
      log.debug("Token deleted from Redis cache");
    } catch (error) {
      log.debug("Redis delete error", { error });
      redisAvailable = false;
    }
  }

  // Fallback cache cleanup
  FALLBACK_CACHE.delete(cacheKey);
}

/**
 * Close Redis connection
 */
export function closeRedisCache(): void {
  if (redisClient) {
    redisClient.close();
    redisClient = null;
    redisAvailable = false;
  }
  FALLBACK_CACHE.clear();
  WEBAUTHN_CHALLENGE_FALLBACK.clear();
}

const WEBAUTHN_CHALLENGE_PREFIX = "webauthn:challenge:";
const WEBAUTHN_CHALLENGE_TTL_SECONDS = 300;

const WEBAUTHN_CHALLENGE_FALLBACK = new Map<
  string,
  { payload: string; expiresAt: number }
>();

/**
 * Store a WebAuthn challenge payload (JSON) for a short-lived token.
 */
export async function setWebAuthnChallengePayload(
  token: string,
  payloadJson: string
): Promise<void> {
  const key = WEBAUTHN_CHALLENGE_PREFIX + token;
  if (redisAvailable && redisClient) {
    try {
      await redisClient.set(key, payloadJson);
      await redisClient.expire(key, WEBAUTHN_CHALLENGE_TTL_SECONDS);
      return;
    } catch (error) {
      log.debug("Redis set error for webauthn challenge", { error });
      redisAvailable = false;
    }
  }
  WEBAUTHN_CHALLENGE_FALLBACK.set(key, {
    payload: payloadJson,
    expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000,
  });
}

/**
 * Read and delete a WebAuthn challenge payload (one-time use).
 */
export async function takeWebAuthnChallengePayload(
  token: string
): Promise<string | null> {
  const key = WEBAUTHN_CHALLENGE_PREFIX + token;
  if (redisAvailable && redisClient) {
    try {
      const cached = await redisClient.get(key);
      if (cached) {
        await redisClient.del(key);
        return cached;
      }
      return null;
    } catch (error) {
      log.debug("Redis get/del error for webauthn challenge", { error });
      redisAvailable = false;
    }
  }
  const entry = WEBAUTHN_CHALLENGE_FALLBACK.get(key);
  WEBAUTHN_CHALLENGE_FALLBACK.delete(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.payload;
  }
  return null;
}
