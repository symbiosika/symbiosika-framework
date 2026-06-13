/**
 * Seed runner CLI entry point.
 *
 * Uses the framework's database connection (createDatabaseClient / getDb)
 * and a fixed seed tenant ID -- same pattern as the test infrastructure.
 *
 * Usage:
 *   bun run seeds/run.ts <scenario>   # e.g. "demo"
 *   bun run seed                      # runs "demo" (default)
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq, and } from "drizzle-orm";
import { Glob } from "bun";
import * as path from "node:path";
import { resolve } from "node:path";
import * as appSchema from "../src/db/schema";
import { factory } from "./factories";

// ============================================================================
// Environment loading
// ============================================================================

/** Load backend/.env into process.env so database connection gets correct config. */
async function loadBackendEnv(): Promise<void> {
  const backendDir = resolve(import.meta.dir, "..");
  const envPath = resolve(backendDir, ".env");
  try {
    const content = await Bun.file(envPath).text();
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env may be missing when using system env only
  }
}

// ============================================================================
// Fixed seed data constants (same ID pattern as test/init.test.ts)
// ============================================================================

export const SEED_TENANT = {
  id: "00000000-1111-1111-1111-000000000099",
  name: "Seed Tenant",
};

export const SEED_USER = {
  id: "00000000-2222-2222-2222-000000000099",
  email: "info@symbiosika.de",
  firstname: "Demo",
  surname: "User",
};

// ============================================================================
// Types
// ============================================================================

export interface SeedContext {
  /** Drizzle database instance -- typed with any schema since framework + app schemas are merged at runtime */
  db: PostgresJsDatabase<any>;
  /** Tenant ID to seed data into */
  tenantId: string;
  /** Logger function */
  log: (message: string) => void;
}

export interface ScenarioModule {
  seed: (ctx: SeedContext) => Promise<unknown>;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const scenario = Bun.argv[2] ?? "demo";
  const log = (msg: string) => console.log(`[seed:${scenario}] ${msg}`);

  log("Starting seed runner...");

  // Load environment variables from backend/.env BEFORE importing db connection
  await loadBackendEnv();

  // Import database connection modules after environment variables are loaded
  const {
    createDatabaseClient,
    getDb,
    waitForDbConnection,
  } = await import("../framework/src/lib/db/db-connection");
  const {
    tenants,
    users,
    tenantMembers,
  } = await import("../framework/src/lib/db/schema/users");
  const { addTenantMember } = await import(
    "../framework/src/lib/usermanagement/tenants"
  );

  // Initialize DB connection (same as tests and app)
  createDatabaseClient(appSchema);
  await waitForDbConnection();

  const db = getDb();

  // ============================================================================
  // Tenant resolution (moved here to access dynamically imported modules)
  // ============================================================================

  async function ensureSeedTenant(): Promise<string> {
    // Always delete the seed tenant first to avoid duplicate data.
    // All app tables use onDelete: "cascade" on tenantId, so this
    // removes all associated data (competitors, financials, etc.) automatically.
    const deleted = await db
      .delete(tenants)
      .where(eq(tenants.id, SEED_TENANT.id))
      .returning({ id: tenants.id });

    if (deleted.length > 0) {
      log(
        `Deleted existing seed tenant and all associated data (${SEED_TENANT.id})`
      );
    }

    // (Re-)create seed tenant with fixed ID
    await db.insert(tenants).values({
      id: SEED_TENANT.id,
      name: SEED_TENANT.name,
    });

    log(`Created seed tenant: ${SEED_TENANT.name} (${SEED_TENANT.id})`);
    return SEED_TENANT.id;
  }

  async function ensureSeedUser(tenantId: string): Promise<string> {
    // Check if seed user already exists
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.id, SEED_USER.id))
      .limit(1);

    if (existing.length > 0) {
      log(`Using existing seed user: ${SEED_USER.email} (${SEED_USER.id})`);
    } else {
      await db.insert(users).values({
        id: SEED_USER.id,
        email: SEED_USER.email,
        firstname: SEED_USER.firstname,
        surname: SEED_USER.surname,
        emailVerified: true,
      });
      log(`Created seed user: ${SEED_USER.email} (${SEED_USER.id})`);
    }

    // Ensure user is member of seed tenant (as owner)
    const membership = await db
      .select()
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.userId, SEED_USER.id),
          eq(tenantMembers.tenantId, tenantId)
        )
      )
      .limit(1);

    if (membership.length === 0) {
      await addTenantMember(tenantId, SEED_USER.id, "owner");
      log(`Added seed user as owner of seed tenant`);
    }

    return SEED_USER.id;
  }

  // Ensure seed tenant and user exist
  const tenantId = await ensureSeedTenant();
  await ensureSeedUser(tenantId);

  // Reset factory sequences for clean IDs
  factory.resetSequence();

  // Discover all *.data.ts files in the scenario folder
  const scenarioDir = path.join(import.meta.dir, "scenarios", scenario);
  const glob = new Glob("*.data.ts");
  const dataFiles: string[] = [];

  for await (const file of glob.scan({ cwd: scenarioDir })) {
    dataFiles.push(file);
  }

  if (dataFiles.length === 0) {
    console.error(
      `No *.data.ts files found in scenario folder "${scenarioDir}".`
    );
    process.exit(1);
  }

  dataFiles.sort();
  log(`Found ${dataFiles.length} data file(s): ${dataFiles.join(", ")}`);

  // Run each data file's seed() function sequentially
  const ctx: SeedContext = { db, tenantId, log };
  const results: Record<string, unknown> = {};

  for (const file of dataFiles) {
    const filePath = path.join(scenarioDir, file);
    const mod: ScenarioModule = await import(filePath).catch(
      (err: unknown) => {
        console.error(`Failed to load data file "${file}".`);
        console.error(err);
        process.exit(1);
      }
    );

    if (typeof mod.seed !== "function") {
      console.error(`Data file "${file}" does not export a seed() function.`);
      process.exit(1);
    }

    log(`Running ${file}...`);
    results[file] = await mod.seed(ctx);
  }

  log("Seed completed successfully!");
  if (Object.keys(results).length > 0) {
    log(`Results: ${JSON.stringify(results, null, 2).slice(0, 1000)}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Seed runner failed:", err);
  process.exit(1);
});
