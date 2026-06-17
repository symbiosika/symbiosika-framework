/**
 * Init Script
 *
 * 1. Copies .env.default from framework if missing
 * 2. Copies .env from .env.default if missing
 * 3. Generates and inserts secrets into .env:
 *    - SECRETS_AES_KEY, SECRETS_AES_IV
 *    - JWT_PUBLIC_KEY, JWT_PRIVATE_KEY
 * 4. Applies app-specific required variables from .env.required-variables (if present)
 * 5. Applies any KEY=VALUE overrides passed as CLI arguments
 *
 * App-specific required variables (./.env.required-variables, optional):
 *   Each line is `KEY=VALUE`. The VALUE supports a small syntax:
 *
 *     KEY=some-string          → set to "some-string" if not already present
 *     KEY={!}some-string       → always set to "some-string" (overwrites existing)
 *     KEY={shared_secret}      → generate a random secret if not already present
 *     KEY={user_input}         → use the value from the current process
 *                                environment (e.g. an exported shell/Docker var)
 *                                if set and non-empty; otherwise prompt on the
 *                                console. Only applied if not already present.
 *                                Empty input skips without overwriting
 *     KEY={!}{user_input}      → always prompt (even if already present)
 *     KEY={folder://PATH:SRC}  → read SRC from the .env in folder PATH (relative
 *                                to the current dir, may be a sibling/parent) and
 *                                use its value; skips if PATH/.env or SRC is missing
 *
 *   The `{!}` prefix forces the value to be (re)applied even when KEY already
 *   has a non-empty value. Without it, present values are left untouched.
 *
 * Usage:
 *   bun run init
 *   bun run init POSTGRES_DB=dev2
 *   bun run init POSTGRES_DB=dev2 POSTGRES_PORT=5433
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { generateAESSecrets } from "../src/lib/crypt/aes-generate";
import { generateJWTKeys } from "../src/lib/utils/jwt-keys";

const envDefaultPath = "./.env.default";
const envPath = "./.env";
const frameworkEnvDefaultPath = "./framework/.env.default";
const envRequiredPath = "./.env.required-variables";

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
 * Parse an .env-style string into a map of KEY -> raw value.
 */
function parseEnv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return map;
}

type RequiredVar = {
  key: string;
  force: boolean; // {!} prefix: (re)apply even if already present
  kind: "literal" | "shared_secret" | "user_input" | "folder_ref";
  literal: string; // only used for kind "literal"
  folderPath: string; // only used for kind "folder_ref"
  sourceKey: string; // only used for kind "folder_ref"
};

/**
 * Parse the .env.required-variables file.
 * See the module header for the supported value syntax.
 */
function parseRequiredVariables(content: string): RequiredVar[] {
  const vars: RequiredVar[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);

    const force = value.startsWith("{!}");
    if (force) value = value.slice(3);

    const base = { key, force, literal: "", folderPath: "", sourceKey: "" };

    if (value === "{shared_secret}") {
      vars.push({ ...base, kind: "shared_secret" });
    } else if (value === "{user_input}") {
      vars.push({ ...base, kind: "user_input" });
    } else if (value.startsWith("{folder://") && value.endsWith("}")) {
      // {folder://PATH:SOURCE_KEY} — PATH may contain ':' (e.g. C:/...),
      // so split on the last ':' before the closing brace.
      const inner = value.slice("{folder://".length, -1);
      const sep = inner.lastIndexOf(":");
      if (sep > 0) {
        vars.push({
          ...base,
          kind: "folder_ref",
          folderPath: inner.slice(0, sep),
          sourceKey: inner.slice(sep + 1),
        });
      } else {
        console.warn(`⚠ Ignoring invalid folder reference for ${key}: ${value}`);
      }
    } else {
      vars.push({ ...base, kind: "literal", literal: value });
    }
  }

  return vars;
}

/**
 * Read SOURCE_KEY from the .env file inside `folderPath` (resolved relative to
 * the current working directory). Returns null if the file or key is missing/empty.
 */
async function readFromFolder(
  folderPath: string,
  sourceKey: string
): Promise<string | null> {
  const sourceEnvPath = join(folderPath, ".env");
  const file = Bun.file(sourceEnvPath);
  if (!(await file.exists())) return null;

  const value = parseEnv(await file.text()).get(sourceKey);
  if (value === undefined || value.trim() === "") return null;

  return value;
}

/**
 * Generate a random shared secret (e.g. for HMAC signing).
 */
function generateSharedSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Apply app-specific required variables from .env.required-variables.
 * Present (non-empty) values are only overwritten when prefixed with {!}.
 */
async function applyRequiredVariables(path: string): Promise<void> {
  const requiredFile = Bun.file(envRequiredPath);
  if (!(await requiredFile.exists())) return;

  const required = parseRequiredVariables(await requiredFile.text());
  if (required.length === 0) return;

  const envFile = Bun.file(path);
  const content = (await envFile.exists()) ? await envFile.text() : "";
  const current = parseEnv(content);

  const isPresent = (key: string): boolean => {
    const value = current.get(key);
    return value !== undefined && value.trim() !== "";
  };

  const updates: Record<string, string> = {};

  for (const required_var of required) {
    if (isPresent(required_var.key) && !required_var.force) continue;

    switch (required_var.kind) {
      case "literal":
        updates[required_var.key] = required_var.literal;
        break;
      case "shared_secret":
        updates[required_var.key] = generateSharedSecret();
        break;
      case "user_input": {
        // Prefer a value already present in the process environment
        // (e.g. an exported shell/Docker sandbox variable) — set it
        // automatically without prompting.
        const fromEnv = process.env[required_var.key];
        if (fromEnv !== undefined && fromEnv.trim() !== "") {
          updates[required_var.key] = fromEnv;
          console.log(`✓ ${required_var.key}: taken from environment`);
          break;
        }
        const answer = prompt(`Enter value for ${required_var.key}:`);
        // Empty input: skip without overwriting.
        if (answer === null || answer.trim() === "") continue;
        updates[required_var.key] = answer;
        break;
      }
      case "folder_ref": {
        const value = await readFromFolder(
          required_var.folderPath,
          required_var.sourceKey
        );
        // Source file/key missing: skip without overwriting.
        if (value === null) {
          console.warn(
            `⚠ ${required_var.key}: ${required_var.sourceKey} not found in ${required_var.folderPath}/.env — skipped`
          );
          continue;
        }
        updates[required_var.key] = value;
        break;
      }
    }
  }

  const keysSet = Object.keys(updates);
  if (keysSet.length === 0) return;

  const lines = content.split("\n");
  const remaining = new Set(keysSet);

  const newLines = lines.map((line: string) => {
    const stripped = line.replace(/\r$/, "");
    for (const key of remaining) {
      const regex = new RegExp(`^${key}=.*$`);
      if (regex.test(stripped)) {
        remaining.delete(key);
        return `${key}=${updates[key]}`;
      }
    }
    return line;
  });

  for (const key of remaining) {
    newLines.push(`${key}=${updates[key]}`);
  }

  await Bun.write(path, newLines.join("\n"));
  console.log(`✓ Applied required variables: ${keysSet.join(", ")}`);
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

  // Apply app-specific required variables (./.env.required-variables)
  await applyRequiredVariables(envPath);

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
