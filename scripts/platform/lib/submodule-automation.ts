/**
 * @fileoverview Generic submodule automation discovery for canonical workflow and rule sync.
 *
 * Flow: root `.gitmodules` -> configured submodule paths -> package folders with canonical source
 * directories -> generated sync targets and root discovery prefixes.
 *
 * @example
 * ```typescript
 * import { PlatformSubmoduleAutomation_discoverPackages } from "./submodule-automation";
 *
 * const packages = PlatformSubmoduleAutomation_discoverPackages({ rootDir: process.cwd() });
 * ```
 *
 * @testing CLI: npx tsx .agents/skills/ide-sync/scripts/canonical-workflows/sync-submodule-discovery.ts (confirm each submodule with canonical workflows appears in generated prompts)
 * @see skills/ide-sync/scripts/canonical-workflows/sync-submodule-discovery.ts - Root workflow generator that consumes workflow-enabled package discovery.
 * @documentation reviewed=2026-05-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Selects which canonical automation directories must be present for a package to match discovery.
 */
export type PlatformSubmoduleAutomation_Feature = "canonicalRules" | "canonicalWorkflows";

/**
 * Presence flags for `canonical-rules` and `canonical-workflows` under a discovered package root.
 */
export type PlatformSubmoduleAutomation_Manifest = {
  canonicalRules: boolean;
  canonicalWorkflows: boolean;
};

/**
 * One git submodule package eligible for rules or workflow sync projection.
 *
 * @remarks
 * `discoveryWorkflowPrefix` is derived from `packageDir` and used to namespace generated workflow
 * command keys so collisions across submodules stay impossible.
 */
export type PlatformSubmoduleAutomation_Package = {
  automation: PlatformSubmoduleAutomation_Manifest;
  discoveryWorkflowPrefix: string;
  packageDir: string;
  packageDisplayName: string;
  packageJsonPath: string;
  packageRoot: string;
};

/**
 * Options for scanning configured submodules and filtering by automation feature.
 */
export type PlatformSubmoduleAutomation_DiscoverPackages_Options = {
  feature?: PlatformSubmoduleAutomation_Feature;
  log?: (message: string) => void;
  rootDir: string;
};

/**
 * Options for building workflow discovery prefixes from the repository root.
 */
export type PlatformSubmoduleAutomation_BuildDiscoveryWorkflowPrefixes_Options = {
  rootDir: string;
};

/**
 * Options for assembling npm-run sync targets from the repository root.
 */
export type PlatformSubmoduleAutomation_BuildGeneratedSyncTargets_Options = {
  rootDir: string;
};

/**
 * Describes one `npm run` invocation the installer or orchestrators should execute for sync.
 */
export type PlatformSubmoduleAutomation_GeneratedSyncTarget = {
  commandArgs: string[];
  cwd: string;
  errorLabel: string;
  label: string;
  logLabel: string;
};

/**
 * Narrows unknown JSON parse results to plain string-keyed objects.
 *
 * @remarks
 * PURITY: local predicate only; does not read the filesystem.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes filesystem path separators to POSIX form for stable comparisons and logs.
 */
function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Reads a JSON file when present and returns a plain object, otherwise null.
 *
 * @remarks
 * I/O: synchronous filesystem read of `filePath`. Malformed JSON logs a warning and yields null.
 */
function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[submodule-automation] Unable to parse JSON at ${filePath}: ${message}`);
    return null;
  }
}

/**
 * Resolves the npm package name from `package.json`, falling back when missing or invalid.
 *
 * @remarks
 * I/O: synchronous read of `packageJsonPath` via `readJsonObject`.
 */
function readPackageName(packageJsonPath: string, fallbackName: string): string {
  const packageJson = readJsonObject(packageJsonPath);
  const packageName = packageJson?.name;
  return typeof packageName === "string" && packageName.trim().length > 0
    ? packageName.trim()
    : fallbackName;
}

/**
 * True when `relativePath` under `rootDir` exists and is a directory.
 *
 * @remarks
 * I/O: synchronous `fs.existsSync` and `fs.statSync` against the joined path.
 */
function hasDirectory(rootDir: string, relativePath: string): boolean {
  const absolutePath = path.join(rootDir, relativePath);
  return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory();
}

/**
 * Lists submodule checkout paths declared in `.gitmodules` at the repository root.
 *
 * @remarks
 * I/O: reads `.gitmodules` and runs `git config --file ... --get-regexp` with `cwd` set to
 * `rootDir`. Returns an empty list when the file is missing, git fails, or stdout is empty.
 */
function listConfiguredSubmodulePaths(rootDir: string): string[] {
  const gitmodulesPath = path.join(rootDir, ".gitmodules");
  if (!fs.existsSync(gitmodulesPath)) {
    return [];
  }

  const result = spawnSync(
    "git",
    [
      "config",
      "--file",
      gitmodulesPath,
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const parts = line.split(/\s+/u);
      const submodulePath = parts[1];
      return typeof submodulePath === "string" && submodulePath.length > 0
        ? [toPosixPath(submodulePath)]
        : [];
    });
}

/**
 * Whether `pkg` should be included for the requested automation `feature` filter.
 *
 * @remarks
 * When `feature` is omitted, any package with rules or workflows automation matches.
 */
function packageMatchesFeature(
  pkg: PlatformSubmoduleAutomation_Package,
  feature: PlatformSubmoduleAutomation_Feature | undefined,
): boolean {
  if (!feature) {
    return pkg.automation.canonicalRules || pkg.automation.canonicalWorkflows;
  }

  return pkg.automation[feature];
}

/**
 * Public entry for reading configured submodule paths from `.gitmodules`.
 *
 * @remarks
 * I/O: delegates to `listConfiguredSubmodulePaths` (git + filesystem).
 */
export function PlatformSubmoduleAutomation_listConfiguredSubmodulePaths(rootDir: string): string[] {
  return listConfiguredSubmodulePaths(rootDir);
}

/**
 * Discovers submodule packages under `rootDir` that opt into canonical automation directories.
 *
 * @remarks
 * I/O: git submodule listing, directory existence checks, and optional `package.json` reads per
 * candidate. Emits skip messages through `options.log` when a configured path is missing on disk.
 */
export function PlatformSubmoduleAutomation_discoverPackages(
  options: PlatformSubmoduleAutomation_DiscoverPackages_Options,
): PlatformSubmoduleAutomation_Package[] {
  const configuredSubmodulePaths = listConfiguredSubmodulePaths(options.rootDir);

  return configuredSubmodulePaths.flatMap((packageDir) => {
    const packageRoot = path.join(options.rootDir, packageDir);
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(packageRoot)) {
      options.log?.(`Skipping ${packageDir}: submodule directory is missing`);
      return [];
    }

    const automation: PlatformSubmoduleAutomation_Manifest = {
      canonicalRules: hasDirectory(packageRoot, "canonical-rules"),
      canonicalWorkflows: hasDirectory(packageRoot, "canonical-workflows"),
    };
    const pkg: PlatformSubmoduleAutomation_Package = {
      automation,
      discoveryWorkflowPrefix: `${packageDir.replace(/[^A-Za-z0-9_-]+/gu, "-")}-`,
      packageDir,
      packageDisplayName: readPackageName(packageJsonPath, packageDir),
      packageJsonPath,
      packageRoot,
    };

    return packageMatchesFeature(pkg, options.feature) ? [pkg] : [];
  });
}

/**
 * Returns stable per-package workflow discovery prefixes for packages with `canonical-workflows`.
 */
export function PlatformSubmoduleAutomation_buildDiscoveryWorkflowPrefixes(
  options: PlatformSubmoduleAutomation_BuildDiscoveryWorkflowPrefixes_Options,
): string[] {
  return PlatformSubmoduleAutomation_discoverPackages({
    feature: "canonicalWorkflows",
    rootDir: options.rootDir,
  }).map((pkg) => pkg.discoveryWorkflowPrefix);
}

/**
 * Builds ordered `npm run` sync targets for the repo root plus each automation-enabled submodule.
 *
 * @remarks
 * Always includes a root `workflows:sync` target, then appends per-package `workflows:sync` and/or
 * `rules:sync` when the corresponding canonical directories exist.
 */
export function PlatformSubmoduleAutomation_buildGeneratedSyncTargets(
  options: PlatformSubmoduleAutomation_BuildGeneratedSyncTargets_Options,
): PlatformSubmoduleAutomation_GeneratedSyncTarget[] {
  const packages = PlatformSubmoduleAutomation_discoverPackages({
    rootDir: options.rootDir,
  });
  const targets: PlatformSubmoduleAutomation_GeneratedSyncTarget[] = [
    {
      commandArgs: ["run", "workflows:sync"],
      cwd: options.rootDir,
      errorLabel: "Root workflow command projection synchronization",
      label: "Root workflow command projection sync",
      logLabel: "root generated workflow commands with npm run workflows:sync",
    },
  ];

  for (const pkg of packages) {
    if (pkg.automation.canonicalWorkflows) {
      targets.push({
        commandArgs: ["run", "workflows:sync"],
        cwd: pkg.packageRoot,
        errorLabel: `${pkg.packageDisplayName} workflow synchronization`,
        label: `${pkg.packageDisplayName} workflow sync`,
        logLabel: `${pkg.packageDisplayName} workflow targets with npm run workflows:sync`,
      });
    }

    if (pkg.automation.canonicalRules) {
      targets.push({
        commandArgs: ["run", "rules:sync"],
        cwd: pkg.packageRoot,
        errorLabel: `${pkg.packageDisplayName} rule synchronization`,
        label: `${pkg.packageDisplayName} rule sync`,
        logLabel: `${pkg.packageDisplayName} rule targets with npm run rules:sync`,
      });
    }
  }

  return targets;
}
