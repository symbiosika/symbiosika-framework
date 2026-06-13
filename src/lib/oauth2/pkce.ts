/**
 * PKCE (RFC 7636) verification. Only S256 is supported — `plain` is rejected.
 */
import * as crypto from "crypto";

const base64url = (buf: Buffer): string => buf.toString("base64url");

/**
 * Compute the S256 code challenge for a verifier:
 * BASE64URL(SHA256(ASCII(code_verifier))).
 */
export const computeS256Challenge = (verifier: string): string =>
  base64url(crypto.createHash("sha256").update(verifier).digest());

/**
 * Verify a PKCE code_verifier against a stored code_challenge.
 * Returns true only for a matching S256 challenge.
 */
export const verifyPkce = (
  codeVerifier: string,
  codeChallenge: string,
  method: string = "S256"
): boolean => {
  if (method !== "S256") {
    return false;
  }
  if (!codeVerifier || !codeChallenge) {
    return false;
  }
  const computed = computeS256Challenge(codeVerifier);
  // Constant-time compare (equal length expected for base64url SHA-256).
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
};
