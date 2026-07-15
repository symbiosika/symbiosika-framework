import { createHash } from "node:crypto";

/**
 * Source hashing for the knowledge sync (opt-in, default off).
 *
 * A stable sha256 over the ingested source lets a re-sync recognise that a
 * file/URL has not changed since the last run and skip the expensive
 * re-parse / re-chunk / re-embed. The hash is stored in the indexed
 * `knowledge_entry.source_hash` column so it is also cheap to query (e.g. to
 * find duplicates).
 *
 * Two granularities are supported:
 *   - RAW BYTES  → `computeSourceHash(bytes)`   — the true "hash over the file"
 *     (compute it where the file bytes exist, e.g. right after download/parse).
 *   - TEXT       → `computeSourceHash(string)`  — a content hash used as a
 *     fallback when only the parsed text is available.
 *
 * The algorithm and encoding are fixed (sha256, lowercase hex, 64 chars) so a
 * hash produced in one run always compares equal to the same input later.
 */
export const SOURCE_HASH_ALGORITHM = "sha256";

/** sha256 (lowercase hex) over raw bytes or a UTF-8 string. */
export const computeSourceHash = (
  input: string | ArrayBuffer | ArrayBufferView
): string => {
  const hash = createHash(SOURCE_HASH_ALGORITHM);
  if (typeof input === "string") {
    hash.update(input, "utf8");
  } else if (input instanceof ArrayBuffer) {
    hash.update(new Uint8Array(input));
  } else {
    hash.update(
      new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    );
  }
  return hash.digest("hex");
};

/**
 * Decide whether a re-sync can skip re-embedding: only when source hashing is
 * in play on both sides AND the stored hash equals the freshly computed one.
 * A missing hash on either side means "cannot prove it's unchanged" → do the
 * work. Kept pure so the decision is unit-testable without a database.
 */
export const isSourceUnchanged = (
  storedHash: string | null | undefined,
  newHash: string | null | undefined
): boolean =>
  typeof storedHash === "string" &&
  storedHash.length > 0 &&
  storedHash === newHash;
