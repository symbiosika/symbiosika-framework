/**
 * Init Script
 *
 * 1. Copies .env.default from framework if missing
 * 2. Copies .env from .env.default if missing
 * 3. Generates and inserts secrets into .env:
 *    - SECRETS_AES_KEY, SECRETS_AES_IV
 *    - JWT_PUBLIC_KEY, JWT_PRIVATE_KEY
 *
 * Usage: bun run init
 */

import { generateAESSecrets } from "../src/lib/crypt/aes-generate";
import { generateJWTKeys } from "../src/lib/utils/jwt-keys";

const envDefaultPath = "./.env.default";
const envPath = "./.env";
const frameworkEnvDefaultPath = "./framework/.env.default";

/**
 * Ensure .env.default exists (copy from framework if missing)
 */
async function ensureEnvDefault(): Promise<void> {
  const envDefault = Bun.file(envDefaultPath);
  if (await envDefault.exists()) return;

  const frameworkEnvDefault = Bun.file(frameworkEnvDefaultPath);
  if (await frameworkEnvDefault.exists()) {
    await Bun.write(envDefaultPath, frameworkEnvDefault);
    console.log("✓ Created .env.default from framework");
  }
}

/**
 * Ensure .env exists (copy from .env.default if missing)
 */
async function ensureEnv(): Promise<void> {
  const env = Bun.file(envPath);
  if (await env.exists()) return;

  const envDefault = Bun.file(envDefaultPath);
  if (await envDefault.exists()) {
    await Bun.write(envPath, envDefault);
    console.log("✓ Created .env from .env.default");
  }
}

/**
 * Update .env file with generated secrets
 * Only updates empty values, preserves existing ones
 */
async function updateEnvFile(
  path: string,
  secrets: Record<string, string>
): Promise<string[]> {
  const keysUpdated: string[] = [];
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return keysUpdated;
  }

  let content = await file.text();
  let updated = false;

  const lines = content.split("\n");
  const newLines = lines.map((line) => {
    for (const [key, value] of Object.entries(secrets)) {
      const regex = new RegExp(`^${key}=\\s*$`);
      if (regex.test(line.replace(/\r$/, ""))) {
        keysUpdated.push(key);
        updated = true;
        return `${key}=${value}`;
      }
    }
    return line;
  });

  if (updated) {
    await Bun.write(path, newLines.join("\n"));
  }

  return keysUpdated;
}

/**
 * Main init function
 */
async function init(): Promise<void> {
  // Ensure config files exist
  await ensureEnvDefault();
  await ensureEnv();

  // Generate secrets
  const aesSecrets = generateAESSecrets();
  const jwtKeys = await generateJWTKeys();

  const allSecrets = {
    SECRETS_AES_KEY: aesSecrets.key,
    SECRETS_AES_IV: aesSecrets.iv,
    JWT_PUBLIC_KEY: jwtKeys.publicKey,
    JWT_PRIVATE_KEY: jwtKeys.publicKey, // jwtKeys.privateKey,
  };

  // Update .env file
  const keysUpdated = await updateEnvFile(envPath, allSecrets);

  if (keysUpdated.length > 0) {
    console.log(`✓ Generated secrets: ${keysUpdated.join(", ")}`);
  } else {
    console.log("ℹ All secrets already set");
  }
}

// Run init
init().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
