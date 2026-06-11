import { createCipheriv, createDecipheriv } from "crypto";
import { randomBytes } from "crypto";
import { generateAESSecrets } from "./aes-generate";

const checkSecrets = async () => {
  if (!process.env.SECRETS_AES_KEY || !process.env.SECRETS_AES_IV) {
    const { key, iv } = generateAESSecrets();

    process.env.SECRETS_AES_KEY = key;
    process.env.SECRETS_AES_IV = iv;

    // Write the generated secret to a local file with owner-only permissions
    // instead of printing it — the AES master key encrypts every tenant secret,
    // so it must not end up in terminal scrollback or log pipelines.
    const { writeFileSync } = await import("node:fs");
    const outPath = "./aes-keys.generated.env";
    writeFileSync(outPath, `SECRETS_AES_KEY=${key}\nSECRETS_AES_IV=${iv}\n`, {
      mode: 0o600,
    });
    console.log(
      `Created new AES key/IV and wrote them to ${outPath} (permissions 0600).`
    );
    console.log("Move them into your .env file, delete the generated file,");
    console.log("then run the application again.");
    process.exit(0);
  }
};

/**
 * The key version that new secrets are encrypted with.
 * Override via SECRETS_AES_KEY_VERSION once a rotation has happened.
 * Version 1 always maps to the legacy SECRETS_AES_KEY env var.
 */
export const CURRENT_KEY_VERSION = Number(
  process.env.SECRETS_AES_KEY_VERSION ?? 1
);

/**
 * Resolve the AES master key for a given key version.
 * - version 1  -> SECRETS_AES_KEY (legacy / current)
 * - version N  -> SECRETS_AES_KEY_V{N}
 *
 * This lets us rotate the master key in the future: new secrets are stamped
 * with CURRENT_KEY_VERSION, while old secrets keep decrypting with the key
 * version stored alongside them.
 */
function getKey(version: number): Buffer {
  const envName = version === 1 ? "SECRETS_AES_KEY" : `SECRETS_AES_KEY_V${version}`;
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(
      `Missing AES key for version ${version} (expected env var ${envName})`
    );
  }
  return Buffer.from(raw, "hex");
}

class AESCipher {
  constructor() {
    checkSecrets();
  }

  encrypt(
    text: string,
    algorithm = "aes-256-cbc",
    keyVersion = CURRENT_KEY_VERSION
  ) {
    const key = getKey(keyVersion);
    const iv = randomBytes(16);
    const cipher = createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = algorithm.includes("gcm")
      ? (cipher as any).getAuthTag().toString("hex")
      : "";
    return (
      iv.toString("hex") + ":" + encrypted + (authTag ? ":" + authTag : "")
    );
  }

  decrypt(encryptedData: string, algorithm = "aes-256-cbc", keyVersion = 1) {
    const key = getKey(keyVersion);
    const parts = encryptedData.split(":");
    const [ivHex, encryptedText, authTag] = parts;
    if (!ivHex || !encryptedText) {
      throw new Error("Invalid encrypted data");
    }
    const iv = Buffer.from(ivHex, "hex");
    const decipher = createDecipheriv(algorithm, key, iv) as any;
    if (algorithm.includes("gcm") && authTag) {
      decipher.setAuthTag(Buffer.from(authTag, "hex"));
    }
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }
}

const aesCipher = new AESCipher();

export function encryptAes(
  text: string,
  algorithm = "aes-256-cbc"
): { value: string; algorithm: string; keyVersion: number } {
  return {
    value: aesCipher.encrypt(text, algorithm, CURRENT_KEY_VERSION),
    algorithm: algorithm,
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export function decryptAes(
  text: string,
  algorithm = "aes-256-cbc",
  keyVersion = 1
): { value: string; algorithm: string; keyVersion: number } {
  return {
    value: aesCipher.decrypt(text, algorithm, keyVersion),
    algorithm: algorithm,
    keyVersion,
  };
}
