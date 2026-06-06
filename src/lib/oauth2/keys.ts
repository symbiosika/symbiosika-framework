/**
 * Signing keys for OAuth2/OIDC.
 *
 * Two distinct mechanisms, by design:
 *  - **Access tokens** use the framework's existing HS256 secret
 *    (`JWT_PRIVATE_KEY`). Only this server verifies them, so symmetric signing
 *    is fine and keeps the existing auth middleware unchanged.
 *  - **OIDC id_tokens** must be verifiable by third-party Relying Parties via
 *    JWKS, which requires an asymmetric key. We reuse the server's real RSA-4096
 *    key pair from `base_server_keys` (PEM), already created on boot.
 */
import * as crypto from "crypto";
import { getServerKeys, initServerKeysIfNeeded } from "../connections/init-server-keys";

/** Framework HMAC secret used for HS256 access tokens. */
export const JWT_HS256_SECRET = process.env.JWT_PRIVATE_KEY || "";

type OidcKeyMaterial = {
  privatePem: string;
  publicPem: string;
  kid: string;
};

let cached: OidcKeyMaterial | null = null;

/**
 * Load (and cache) the RSA key pair used to sign id_tokens. Reuses the server
 * identity key from the DB, creating it if missing.
 */
export const getOidcKeyMaterial = async (): Promise<OidcKeyMaterial> => {
  if (cached) {
    return cached;
  }
  let keys = await getServerKeys();
  if (!keys) {
    keys = await initServerKeysIfNeeded();
  }
  if (!keys) {
    throw new Error("Server keys are not available for OIDC signing");
  }
  const kid = crypto
    .createHash("sha256")
    .update(keys.publicKey)
    .digest("hex")
    .slice(0, 16);
  cached = { privatePem: keys.privateKey, publicPem: keys.publicKey, kid };
  return cached;
};
