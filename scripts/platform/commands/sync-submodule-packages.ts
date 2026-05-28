#!/usr/bin/env -S npx tsx
/**
 * @fileoverview Runs package-local `npm run sync` commands for existing root submodules.
 *
 * Flow: read .gitmodules paths -> filter existing package.json files -> require a local
 * `sync` script -> run each package sync sequentially with inherited stdio so
 * generated-artifact output remains visible.
 *
 * @example
 * ```bash
 * npx tsx scripts/platform/commands/sync-submodule-packages.ts --dry-run
 * ```
 *
 * @testing CLI manual: run `npm run sync:submodules -- --dry-run` to confirm existing
 * submodule sync targets are discovered without mutating generated files.
 * @see package.json - Root `sync` invokes this command after root-owned sync targets finish.
 * @documentation reviewed=2026-05-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  platformCommandRuntime_isMainModule,
  platformCommandRuntime_resolveNpmCommand,
} from "../lib/command-runtime.js";
import { resolveRepoRoot } from "../lib/orchestration.js";

/** JSON object shape used after defensive package.json parsing. */
type JsonRecord = {
  [key: string]: unknown;
};

/** Existing submodule package that can run its package-local sync script. */
type SyncSubmodulePackage_Target = {
  packageDirectory: string;
  packageName: string;
  syncScript: string;
};

/** Returns true when an unknown parsed JSON value is a non-array object. */
function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a JSON object file, returning null for missing, invalid, or non-object content. */
function readJsonRecord(filePath: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads submodule paths from the root .gitmodules file without shelling out to git. */
function readSubmodulePaths(repoRoot: string): string[] {
  const gitmodulesPath = path.join(repoRoot, ".gitmodules");
  if (!fs.existsSync(gitmodulesPath)) {
    return [];
  }

  const paths: string[] = [];
  for (const line of fs.readFileSync(gitmodulesPath, "utf8").split("\n")) {
    const match = /^path\s*=\s*(.+)$/.exec(line.trim());
    if (match && typeof match[1] === "string") {
      paths.push(match[1].trim());
    }
  }

  return paths;
}

/**
 * Reads a submodule `package.json` and returns a narrowed JSON object contract.
 *
 * @remarks
 * Thin wrapper around `readJsonRecord` so discovery treats package manifests as the same defensive
 * parse path as other JSON inputs (missing file, invalid JSON, or non-object root yield null).
 */
function readPackageJson(packageJsonPath: string): JsonRecord | null {
  return readJsonRecord(packageJsonPath);
}

/** Returns the package-local sync script body when the package exposes one. */
function readSyncScript(packageJson: JsonRecord): string | null {
  const scripts = packageJson["scripts"];
  if (!isJsonRecord(scripts)) {
    return null;
  }

  const syncScript = scripts["sync"];
  return typeof syncScript === "string" ? syncScript : null;
}

/**
 * Resolves the npm package name used for logging and skip rules during discovery.
 *
 * @remarks
 * Accepts the first non-empty string `name` field; otherwise uses `fallbackName` (the submodule
 * path segment) so partially authored or anonymous manifests still produce stable labels.
 */
function readPackageName(packageJson: JsonRecord, fallbackName: string): string {
  const name = packageJson["name"];
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : fallbackName;
}

/** Discovers existing git submodule packages that expose `npm run sync`. */
function discoverSyncTargets(repoRoot: string): SyncSubmodulePackage_Target[] {
  const submodulePaths = readSubmodulePaths(repoRoot);
  if (submodulePaths.length === 0) {
    throw new Error(
      `Could not find submodule paths in ${path.join(repoRoot, ".gitmodules")}`,
    );
  }

  const targets: SyncSubmodulePackage_Target[] = [];
  for (const packageDirectory of submodulePaths) {
    if (packageDirectory === ".") {
      console.log("⚠️  Skipping root path entry to avoid recursive npm run sync.");
      continue;
    }

    const packageJsonPath = path.join(repoRoot, packageDirectory, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      console.log(`⚠️  Skipping ${packageDirectory} (no package.json found)`);
      continue;
    }

    const packageJson = readPackageJson(packageJsonPath);
    if (packageJson === null) {
      console.log(`⚠️  Skipping ${packageDirectory} (invalid package.json)`);
      continue;
    }

    const packageName = readPackageName(packageJson, packageDirectory);
    if (packageName === "ide-sync") {
      console.log(`⚠️  Skipping ${packageDirectory} (sync tool submodule)`);
      continue;
    }

    const syncScript = readSyncScript(packageJson);
    if (syncScript === null) {
      console.log(`⚠️  Skipping ${packageDirectory} (no sync script found)`);
      continue;
    }

    targets.push({ packageDirectory, packageName, syncScript });
  }

  return targets;
}

/** Runs one package-local sync script and returns false when npm exits unsuccessfully. */
function runSyncTarget(options: {
  npmCommand: string;
  repoRoot: string;
  target: SyncSubmodulePackage_Target;
}): boolean {
  console.log("");
  console.log(`📦 Syncing ${options.target.packageDirectory}...`);

  const result = spawnSync(
    options.npmCommand,
    ["run", "sync", "--prefix", options.target.packageDirectory],
    {
      cwd: options.repoRoot,
      stdio: "inherit",
    },
  );

  if (result.signal) {
    console.error(
      `❌ ${options.target.packageDirectory} sync stopped by signal ${result.signal}`,
    );
    return false;
  }

  if (result.status !== 0) {
    console.error(
      `❌ ${options.target.packageDirectory} sync failed with exit code ${result.status ?? 1}`,
    );
    return false;
  }

  console.log(`✅ ${options.target.packageDirectory} sync completed`);
  return true;
}

/** Parses CLI flags, prints the discovered target list, and optionally runs every target. */
function main(): number {
  const dryRun = process.argv.includes("--dry-run");
  const repoRoot = resolveRepoRoot();
  const targets = discoverSyncTargets(repoRoot);

  console.log("🔄 Discovering submodule package sync targets...");
  if (targets.length === 0) {
    console.log("No existing submodule packages expose npm run sync.");
    return 0;
  }

  for (const target of targets) {
    console.log(`- ${target.packageDirectory}: ${target.syncScript}`);
  }

  if (dryRun) {
    console.log("");
    console.log("Dry run complete; no submodule sync commands were executed.");
    return 0;
  }

  const npmCommand = platformCommandRuntime_resolveNpmCommand();
  let failed = false;
  for (const target of targets) {
    if (!runSyncTarget({ npmCommand, repoRoot, target })) {
      failed = true;
      break;
    }
  }

  console.log("");
  if (failed) {
    console.log("❌ Submodule package sync failed.");
    return 1;
  }

  console.log("🎉 Submodule package sync completed.");
  return 0;
}

/** CLI entry for root-to-submodule package sync orchestration. */
export function platformSyncSubmodulePackagesMain(): void {
  process.exit(main());
}

if (platformCommandRuntime_isMainModule(import.meta.url)) {
  platformSyncSubmodulePackagesMain();
}
