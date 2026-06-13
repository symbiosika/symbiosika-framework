import { secrets, type SecretsSelect } from "../db/schema/secrets";
import { eq, and } from "drizzle-orm";
import { encryptAes, decryptAes } from "./aes";
import { getDb } from "../db/db-connection";

/**
 * Check is a name is fully uppercase and only contains letters, numbers and underscores
 */
export function isValidSecretName(name: string) {
  return /^[A-Z0-9_]+$/.test(name);
}

/**
 * Set a new secret to use it in the backend
 */
export async function setSecret(data: {
  name: string;
  value: string;
  tenantId: string;
}): Promise<SecretsSelect> {
  if (!isValidSecretName(data.name)) {
    throw new Error(
      "Invalid secret name Only. uppercase letters, numbers and underscores are allowed"
    );
  }
  // Encrypt the value before storing
  const encrypted = encryptAes(data.value);

  // Insert new secret
  const entries = await getDb()
    .insert(secrets)
    .values({
      reference: "VARIABLES",
      name: data.name,
      label: data.name,
      value: encrypted.value,
      type: encrypted.algorithm,
      keyVersion: encrypted.keyVersion,
      tenantId: data.tenantId,
    })
    .onConflictDoUpdate({
      target: [secrets.reference, secrets.name],
      set: {
        value: encrypted.value,
        type: encrypted.algorithm,
        keyVersion: encrypted.keyVersion,
      },
    })
    .returning();

  if (!entries[0]) {
    throw new Error("Failed to set secret");
  }
  return { ...entries[0], value: "" };
}

/**
 * Get a backend secret by its name
 */
export async function getSecret(
  name: string,
  tenantId: string
): Promise<string | null> {
  const result = await getDb()
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.reference, "VARIABLES"),
        eq(secrets.name, name),
        eq(secrets.tenantId, tenantId)
      )
    )
    .limit(1);

  if (!result[0]) {
    return null;
  }
  const secret = result[0];
  // Decrypt the value before returning, using the key version it was encrypted with
  const decrypted = decryptAes(secret.value, secret.type, secret.keyVersion);

  return decrypted.value;
}

/**
 * Delete a backend secret by its name
 */
export async function deleteSecret(name: string, tenantId: string) {
  return await getDb()
    .delete(secrets)
    .where(
      and(
        eq(secrets.reference, "VARIABLES"),
        eq(secrets.name, name),
        eq(secrets.tenantId, tenantId)
      )
    )
    .returning();
}

/**
 * Get all backend secrets
 */
export async function getSecrets(tenantId: string) {
  return await getDb()
    .select({
      id: secrets.id,
      name: secrets.name,
    })
    .from(secrets)
    .where(
      and(eq(secrets.reference, "VARIABLES"), eq(secrets.tenantId, tenantId))
    );
}
