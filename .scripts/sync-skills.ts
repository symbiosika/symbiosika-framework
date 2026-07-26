/**
 * Sync Skills Script
 *
 * This script copies all skills from the framework's docs/skills directory
 * to the project's Cursor and Claude Code skill directories.
 *
 * Usage: bun run sync-skills
 */

import fs from "fs";
import path from "path";

// Get the framework root directory (parent of .scripts)
const frameworkDir = path.join(__dirname, "..");
const projectRoot = path.join(frameworkDir, "..", "..");

// Source directory containing skills
const skillsSourceDir = path.join(frameworkDir, "docs", "skills");

// Target directories for different AI tools
const targetDirs = [
  // path.join(projectRoot, ".claude", "skills"),
  path.join(projectRoot, ".claude", "skills"),
];

// Directories to exclude from syncing
const excludeDirs = ["example"];

/**
 * Recursively copy a directory
 */
function copyDirRecursive(src: string, dest: string): void {
  // Create destination directory if it doesn't exist
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Get all skill directories (directories containing SKILL.md)
 */
function getSkillDirs(baseDir: string): string[] {
  const skillDirs: string[] = [];

  function findSkills(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(dir, entry.name);
        const skillMdPath = path.join(skillPath, "SKILL.md");

        if (fs.existsSync(skillMdPath)) {
          skillDirs.push(skillPath);
        } else {
          // Check subdirectories
          findSkills(skillPath);
        }
      }
    }
  }

  findSkills(baseDir);
  return skillDirs;
}

/**
 * Read the `name` from a SKILL.md YAML frontmatter block.
 * Returns undefined when there is no frontmatter or no name field.
 */
function readSkillName(skillMdPath: string): string | undefined {
  const content = fs.readFileSync(skillMdPath, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!frontmatter?.[1]) return undefined;
  const name = /^name:[ \t]*(.+)$/m.exec(frontmatter[1]);
  return name?.[1]?.trim().replace(/^["']|["']$/g, "");
}

/**
 * The skill format requires `name` to equal the containing directory name: the
 * directory name is what an agent invokes, so a mismatch makes the skill
 * unreachable by name. Fail the sync instead of shipping broken skills to every
 * app that consumes them.
 */
function assertSkillNamesMatchDirectories(skillDirs: string[]): void {
  const problems: string[] = [];

  for (const skillDir of skillDirs) {
    const dirName = path.basename(skillDir);
    if (excludeDirs.includes(dirName)) continue;

    const name = readSkillName(path.join(skillDir, "SKILL.md"));
    if (!name) {
      problems.push(`  - ${dirName}: SKILL.md has no "name" in its frontmatter`);
    } else if (name !== dirName) {
      problems.push(`  - ${dirName}: frontmatter name is "${name}"`);
    }
  }

  if (problems.length > 0) {
    console.error(
      "Error: skill name(s) do not match their directory name:\n" +
        problems.join("\n") +
        "\n\nFix the frontmatter (or rename the directory) and run the sync again."
    );
    process.exit(1);
  }
}

/**
 * Main sync function
 */
function syncSkills(): void {
  console.log("Syncing skills from framework to project directories...\n");

  // Check if source directory exists
  if (!fs.existsSync(skillsSourceDir)) {
    console.error(`Error: Skills source directory not found: ${skillsSourceDir}`);
    process.exit(1);
  }

  // Get all skill directories
  const skillDirs = getSkillDirs(skillsSourceDir);

  if (skillDirs.length === 0) {
    console.log("No skills found in source directory.");
    return;
  }

  assertSkillNamesMatchDirectories(skillDirs);

  console.log(`Found ${skillDirs.length} skill(s) to sync:\n`);

  // Sync to each target directory
  for (const targetDir of targetDirs) {
    console.log(`Target: ${targetDir}`);

    // Create target directory if it doesn't exist
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    for (const skillDir of skillDirs) {
      const skillName = path.basename(skillDir);

      // Skip excluded directories
      if (excludeDirs.includes(skillName)) {
        console.log(`  - Skipped: ${skillName} (excluded)`);
        continue;
      }

      const destDir = path.join(targetDir, skillName);

      // Remove existing skill directory if it exists (overwrite)
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }

      // Copy skill directory
      copyDirRecursive(skillDir, destDir);
      console.log(`  - Copied: ${skillName}`);
    }

    console.log("");
  }

  console.log("Skills sync completed successfully!");
}

// Run the sync
syncSkills();
