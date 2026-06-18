/**
 * @framework/crypt — encrypted secret storage (per tenant).
 *
 * Secrets are stored AES-encrypted; these helpers handle set/get/delete and
 * name validation.
 *
 * Part of the curated framework public API. See ./README.md.
 */
export {
  getSecret,
  setSecret,
  deleteSecret,
  getSecrets,
  isValidSecretName,
} from "../lib/crypt";
