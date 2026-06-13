/**
 * Shared OAuth2 helpers.
 */
import * as crypto from "crypto";

/** SHA-256 hex digest — used to store codes/tokens hashed at rest. */
export const sha256hex = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

/**
 * Parse a DB timestamp as UTC milliseconds.
 *
 * Our `timestamp` columns are stored without timezone but always written via
 * `Date.toISOString()` (UTC). When read back, postgres returns a naive string
 * ("YYYY-MM-DD HH:MM:SS.mmm") which `new Date()` would wrongly interpret as
 * LOCAL time. We therefore interpret naive values explicitly as UTC.
 */
export const parseUtcMs = (dbTimestamp: string): number => {
  let iso = dbTimestamp.includes("T")
    ? dbTimestamp
    : dbTimestamp.replace(" ", "T");
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso)) {
    iso += "Z";
  }
  return Date.parse(iso);
};

/** True if the given DB timestamp lies in the past. */
export const isExpired = (dbTimestamp: string): boolean =>
  parseUtcMs(dbTimestamp) <= Date.now();
