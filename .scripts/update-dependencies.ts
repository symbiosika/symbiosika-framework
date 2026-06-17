/**
 * Update Dependencies Script
 *
 * Syncs all dependencies declared by the framework (./framework/package.json)
 * into the app's package.json located in the current working directory (the
 * folder the script is run from — typically one level above the framework).
 *
 * Rules:
 *   - Framework `dependencies`     → app `dependencies`
 *   - Framework `peerDependencies` → app `dependencies`
 *     (peer deps must be installed by the consuming app)
 *   - Framework `devDependencies`  → app `devDependencies`
 *
 *   For each framework dependency:
 *     - If the app does NOT have it yet  → add it (in the target section above).
 *     - If the app HAS it with an OLDER version → bump it to the framework
 *       version spec (verbatim, including the range prefix like `^`).
 *     - If the app already has it at the same or a newer version → leave it.
 *
 *   App-only dependencies are never touched or removed. Dependencies are kept
 *   alphabetically sorted per section.
 *
 * Usage:
 *   bun run update-dependencies
 *   bun run update-dependencies --dry-run    # show changes without writing
 */

const frameworkPkgPath = "./framework/package.json";
const appPkgPath = "./package.json";

type DepMap = Record<string, string>;

type PackageJson = {
  dependencies?: DepMap;
  devDependencies?: DepMap;
  peerDependencies?: DepMap;
  [key: string]: unknown;
};

type AppSection = "dependencies" | "devDependencies";

/**
 * Split a version spec into its range prefix and the numeric core version.
 * Example: "^13.0.0" → { prefix: "^", version: "13.0.0" }
 */
function parseSpec(spec: string): { prefix: string; version: string } {
  const match = spec.trim().match(/^([^\d]*)(.*)$/);
  return { prefix: match?.[1] ?? "", version: match?.[2] ?? spec.trim() };
}

/**
 * Compare two core version strings (ignores any range prefix and prerelease
 * suffix). Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const partsB = b.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const da = partsA[i] ?? 0;
    const db = partsB[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * Find which app section currently declares the given dependency.
 */
function findInApp(app: PackageJson, name: string): AppSection | null {
  if (app.dependencies?.[name] !== undefined) return "dependencies";
  if (app.devDependencies?.[name] !== undefined) return "devDependencies";
  return null;
}

/**
 * Sort an object's keys alphabetically and return a new object.
 */
function sortKeys(map: DepMap): DepMap {
  const sorted: DepMap = {};
  for (const key of Object.keys(map).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = map[key];
  }
  return sorted;
}

type Change = { name: string; from: string | null; to: string; section: AppSection };

async function updateDependencies(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  const frameworkFile = Bun.file(frameworkPkgPath);
  const appFile = Bun.file(appPkgPath);

  if (!(await frameworkFile.exists())) {
    console.error(`✗ Framework package.json not found at ${frameworkPkgPath}`);
    process.exit(1);
  }
  if (!(await appFile.exists())) {
    console.error(`✗ App package.json not found at ${appPkgPath}`);
    process.exit(1);
  }

  const framework = (await frameworkFile.json()) as PackageJson;
  const app = (await appFile.json()) as PackageJson;

  // Collect framework deps mapped to their target section in the app.
  const frameworkDeps: Array<{ name: string; spec: string; target: AppSection }> = [];
  for (const [name, spec] of Object.entries(framework.dependencies ?? {})) {
    frameworkDeps.push({ name, spec, target: "dependencies" });
  }
  for (const [name, spec] of Object.entries(framework.peerDependencies ?? {})) {
    frameworkDeps.push({ name, spec, target: "dependencies" });
  }
  for (const [name, spec] of Object.entries(framework.devDependencies ?? {})) {
    frameworkDeps.push({ name, spec, target: "devDependencies" });
  }

  app.dependencies ??= {};
  app.devDependencies ??= {};

  const added: Change[] = [];
  const updated: Change[] = [];

  for (const { name, spec, target } of frameworkDeps) {
    const existingSection = findInApp(app, name);

    // Not present anywhere in the app → add to the target section.
    if (existingSection === null) {
      app[target]![name] = spec;
      added.push({ name, from: null, to: spec, section: target });
      continue;
    }

    // Present → only bump if the framework version is strictly newer.
    const current = app[existingSection]![name];
    const fwVersion = parseSpec(spec).version;
    const appVersion = parseSpec(current).version;

    if (compareVersions(fwVersion, appVersion) > 0) {
      app[existingSection]![name] = spec;
      updated.push({ name, from: current, to: spec, section: existingSection });
    }
  }

  // Keep sections alphabetically sorted.
  app.dependencies = sortKeys(app.dependencies);
  app.devDependencies = sortKeys(app.devDependencies);

  // Report.
  if (added.length === 0 && updated.length === 0) {
    console.log("ℹ All framework dependencies already in sync — nothing to do.");
    return;
  }

  if (updated.length > 0) {
    console.log("Updated (version bumped):");
    for (const c of updated) {
      console.log(`  ↑ ${c.name}: ${c.from} → ${c.to} [${c.section}]`);
    }
  }
  if (added.length > 0) {
    console.log("Added (missing):");
    for (const c of added) {
      console.log(`  + ${c.name}: ${c.to} [${c.section}]`);
    }
  }

  if (dryRun) {
    console.log("\n--dry-run: no changes written.");
    return;
  }

  await Bun.write(appPkgPath, JSON.stringify(app, null, 2) + "\n");
  console.log(
    `\n✓ Updated ${appPkgPath} (${added.length} added, ${updated.length} bumped).`
  );
  console.log("  Run `bun install` to apply the changes.");
}

updateDependencies().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
