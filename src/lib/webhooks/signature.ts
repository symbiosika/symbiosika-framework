/**
 * HMAC signing/verification for outgoing webhooks.
 *
 * Modelled on the Stripe/GitHub webhook signature scheme: the receiver stores a
 * shared secret and can verify that a delivery genuinely originates from us and
 * was not tampered with, WITHOUT the secret ever travelling on the wire.
 *
 * The signature is computed over `"<timestamp>.<rawBody>"` so that a captured
 * request cannot be replayed later (the receiver rejects timestamps outside a
 * tolerance window).
 *
 *   X-Symbiosika-Timestamp: <unix seconds>
 *   X-Symbiosika-Signature: v1=<hex hmac-sha256>
 *
 * Verification uses a constant-time comparison to avoid timing side-channels.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Symbiosika-Signature";
export const TIMESTAMP_HEADER = "X-Symbiosika-Timestamp";
export const EVENT_HEADER = "X-Symbiosika-Event";
export const DELIVERY_HEADER = "X-Symbiosika-Delivery";

/** Prefix for generated signing secrets (Stripe-style, easy to recognise). */
export const SIGNING_SECRET_PREFIX = "whsec_";

/**
 * Generate a new signing secret: the recognisable prefix + 32 random bytes as
 * URL-safe base64 (~43 chars of entropy). Shown to the operator exactly once.
 */
export const generateSigningSecret = (): string =>
  SIGNING_SECRET_PREFIX + randomBytes(32).toString("base64url");

/**
 * Compute the raw hex HMAC-SHA256 of `"<timestamp>.<payload>"` using `secret`.
 */
export const computeSignature = (
  secret: string,
  payload: string,
  timestampSeconds: number
): string =>
  createHmac("sha256", secret)
    .update(`${timestampSeconds}.${payload}`)
    .digest("hex");

/**
 * Build the signature headers for a delivery. `timestampSeconds` defaults to
 * "now"; pass it explicitly in tests for determinism.
 */
export const buildSignatureHeaders = (
  secret: string,
  payload: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000)
): Record<string, string> => ({
  [TIMESTAMP_HEADER]: String(timestampSeconds),
  [SIGNATURE_HEADER]: `v1=${computeSignature(secret, payload, timestampSeconds)}`,
});

/** Constant-time comparison of two hex strings of equal expected length. */
const safeHexEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};

/**
 * Verify a signature header against the payload. Mirrors what a receiver should
 * implement; also used by tests.
 *
 * @param toleranceSeconds max age (and future skew) of the timestamp; the
 *        default 300s (5 min) is the common industry value and blocks replays.
 */
export const verifySignature = (opts: {
  secret: string;
  payload: string;
  signatureHeader: string | null | undefined;
  timestampHeader: string | null | undefined;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean => {
  const {
    secret,
    payload,
    signatureHeader,
    timestampHeader,
    toleranceSeconds = 300,
  } = opts;
  if (!signatureHeader || !timestampHeader) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false; // outside the tolerance window → treat as replay/stale
  }

  // header form: "v1=<hex>"; be lenient about a missing scheme prefix.
  const provided = signatureHeader.startsWith("v1=")
    ? signatureHeader.slice(3)
    : signatureHeader;
  const expected = computeSignature(secret, payload, timestamp);
  return safeHexEqual(provided, expected);
};
