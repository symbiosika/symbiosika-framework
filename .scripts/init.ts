/**
 * Init Script
 *
 * 1. Copies .env.default from framework if missing
 * 2. Copies .env from .env.default if missing
 * 3. Generates and inserts secrets into .env:
 *    - SECRETS_AES_KEY, SECRETS_AES_IV
 *    - JWT_PUBLIC_KEY, JWT_PRIVATE_KEY
 * 4. Applies any KEY=VALUE overrides passed as CLI arguments
 *
 * Usage:
 *   bun run init
 *   bun run init POSTGRES_DB=dev2
 *   bun run init POSTGRES_DB=dev2 POSTGRES_PORT=5433
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
 * Parse KEY=VALUE overrides from CLI arguments.
 * Example: `bun run init POSTGRES_DB=dev2 LOG_LEVEL=debug`
 */
function parseOverrides(argv: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};

  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      console.warn(`⚠ Ignoring argument (expected KEY=VALUE): ${arg}`);
      continue;
    }
    const key = arg.slice(0, eq).trim();
    const value = arg.slice(eq + 1);
    overrides[key] = value;
  }

  return overrides;
}

/**
 * Set the given KEY=VALUE pairs in the .env file.
 * Replaces existing values (set or empty) and appends missing keys.
 */
async function applyOverrides(
  path: string,
  overrides: Record<string, string>
): Promise<string[]> {
  const keysSet: string[] = [];
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return keysSet;
  }

  const content = await file.text();
  const lines = content.split("\n");
  const remaining = new Set(Object.keys(overrides));

  const newLines = lines.map((line) => {
    const stripped = line.replace(/\r$/, "");
    for (const key of remaining) {
      const regex = new RegExp(`^${key}=.*$`);
      if (regex.test(stripped)) {
        remaining.delete(key);
        keysSet.push(key);
        return `${key}=${overrides[key]}`;
      }
    }
    return line;
  });

  // Append keys that did not yet exist in the file
  for (const key of remaining) {
    newLines.push(`${key}=${overrides[key]}`);
    keysSet.push(key);
  }

  if (keysSet.length > 0) {
    await Bun.write(path, newLines.join("\n"));
  }

  return keysSet;
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

  // Apply KEY=VALUE overrides from CLI arguments
  const overrides = parseOverrides(process.argv.slice(2));
  if (Object.keys(overrides).length > 0) {
    const keysSet = await applyOverrides(envPath, overrides);
    if (keysSet.length > 0) {
      console.log(`✓ Applied overrides: ${keysSet.join(", ")}`);
    }
  }
}

// Run init
init().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
