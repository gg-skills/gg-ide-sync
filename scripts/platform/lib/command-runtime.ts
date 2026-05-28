/**
 * @fileoverview Resolves platform command execution context, repo paths, npm binaries, and supported Node version checks.
 *
 * Flow: module URL -> repo root -> npm/npx resolution -> supported Node guard.
 *
 * @example
 * ```typescript
 * const npmCommand = platformCommandRuntime_resolveNpmCommand();
 * ```
 *
 * @testing CLI manual: run any platform command from the repo root and confirm the command-runtime guard accepts the current Node version before execution continues.
 * @see scripts/platform/commands/build-all.ts - Representative command entrypoint that resolves repo paths and npm binaries through this runtime.
 * @documentation reviewed=2026-04-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_NODE_GUARD_ENV_FLAG = "GG_IDE_SYNC_NODE_TOOLCHAIN_GUARD_ACTIVE";

/**
 * Normalizes a Node semver token so comparisons align with `process.version`-style `v`-prefixed strings.
 *
 * @remarks
 * PURITY: Pure string normalization only.
 *
 * @throws Error When trimming and optional prefix handling yield an empty version token.
 */
function platformCommandRuntime_normalizeNodeVersion(rawVersion: string): string {
  const trimmedVersion = rawVersion.trim();
  const normalizedVersion = trimmedVersion.startsWith("v")
    ? trimmedVersion
    : `v${trimmedVersion}`;

  if (normalizedVersion === "v") {
    throw new Error("Node version cannot be empty.");
  }

  return normalizedVersion;
}

/**
 * Loads a pinned Node version string from a repo toolchain file such as `.nvmrc`.
 *
 * @remarks
 * I/O: Synchronous filesystem existence check and UTF-8 read of `versionFilePath`.
 *
 * @returns `null` when the file is missing, unreadable as empty after trim, or contains only whitespace.
 */
function platformCommandRuntime_readNodeVersionFile(versionFilePath: string): string | null {
  if (!fs.existsSync(versionFilePath)) {
    return null;
  }

  const rawVersion = fs.readFileSync(versionFilePath, "utf8").trim();
  if (rawVersion.length === 0) {
    return null;
  }

  return platformCommandRuntime_normalizeNodeVersion(rawVersion);
}

/**
 * Locates an NVM-managed `node` binary matching the required semver directory name under common install roots.
 *
 * @remarks
 * I/O: Synchronous `existsSync` probes under `$NVM_DIR` (when set) and `~/.nvm` using NVM's `versions/node/<version>/bin/node` layout.
 *
 * @returns The absolute path to the matching binary, or `null` when no candidate exists on disk.
 */
function platformCommandRuntime_findNvmNodeBinary(requiredVersion: string): string | null {
  const searchRoots: string[] = [];

  if (typeof process.env.NVM_DIR === "string" && process.env.NVM_DIR.trim().length > 0) {
    searchRoots.push(process.env.NVM_DIR.trim());
  }

  searchRoots.push(path.join(os.homedir(), ".nvm"));

  for (const searchRoot of searchRoots) {
    const candidateNodePath = path.join(
      searchRoot,
      "versions",
      "node",
      requiredVersion,
      "bin",
      "node",
    );
    if (fs.existsSync(candidateNodePath)) {
      return candidateNodePath;
    }
  }

  return null;
}

/** Returns true if the importing module URL is the main entry point (i.e., the file being executed directly rather than imported). Used to guard side-effects in command wrappers. */
export function platformCommandRuntime_isMainModule(moduleUrl: string): boolean {
  const entryPath = process.argv[1];
  return entryPath ? path.resolve(entryPath) === fileURLToPath(moduleUrl) : false;
}

/** Resolves the directory containing the module at the given URL. */
export function platformCommandRuntime_resolveScriptDir(moduleUrl: string): string {
  return path.dirname(fileURLToPath(moduleUrl));
}

/** Resolves the `scripts/` directory path by walking up from the given module URL until the directory named `scripts` is found. */
export function platformCommandRuntime_resolveScriptsDir(moduleUrl: string): string {
  let currentDir = platformCommandRuntime_resolveScriptDir(moduleUrl);

  while (path.basename(currentDir) !== "scripts") {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        `[platform] Could not resolve scripts directory from module URL: ${moduleUrl}`,
      );
    }
    currentDir = parentDir;
  }

  return currentDir;
}

/** Resolves the repository root directory from the given module URL by resolving up through the `scripts/` directory. */
export function platformCommandRuntime_resolveRootDir(moduleUrl: string): string {
  return path.dirname(platformCommandRuntime_resolveScriptsDir(moduleUrl));
}

/** Returns `npm` or `npm.cmd` depending on the current OS platform (Windows vs Unix). */
export function platformCommandRuntime_resolveNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/** Returns `npx` or `npx.cmd` depending on the current OS platform (Windows vs Unix). */
export function platformCommandRuntime_resolveNpxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

/**
 * Guards that the current Node.js process is the version required by the repo's `.nvmrc`.
 *
 * If the version matches, returns silently.
 * If the version differs and `GG_IDE_SYNC_NODE_TOOLCHAIN_GUARD_ACTIVE` is already set, throws.
 * Otherwise, searches `$NVM_DIR/versions/node/<requiredVersion>/bin/node` and re-executes the current script with the correct binary.
 */
export function platformCommandRuntime_ensureSupportedNodeVersion(options: {
  label: string;
  projectRoot: string;
}): void {
  const versionFilePath = path.join(options.projectRoot, ".nvmrc");
  const requiredVersion = platformCommandRuntime_readNodeVersionFile(versionFilePath);

  if (requiredVersion === null) {
    throw new Error(
      `[platform:${options.label}] missing required Node version file: ${versionFilePath}`,
    );
  }

  const currentVersion = platformCommandRuntime_normalizeNodeVersion(process.version);
  if (currentVersion === requiredVersion) {
    return;
  }

  if (process.env[PLATFORM_NODE_GUARD_ENV_FLAG] === "true") {
    throw new Error(
      `[platform:${options.label}] required Node ${requiredVersion} from ${versionFilePath}, but the guarded runtime is still ${currentVersion}.`,
    );
  }

  const nodeBinaryPath = platformCommandRuntime_findNvmNodeBinary(requiredVersion);
  if (nodeBinaryPath === null) {
    throw new Error(
      `[platform:${options.label}] required Node ${requiredVersion} from ${versionFilePath}, current ${currentVersion}. Matching NVM toolchain was not found. Run "nvm use" in ${options.projectRoot} and retry.`,
    );
  }

  const reexecEnvironment = {
    ...process.env,
    PATH: `${path.dirname(nodeBinaryPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    [PLATFORM_NODE_GUARD_ENV_FLAG]: "true",
  };
  const scriptArgv = process.argv.slice(1);
  if (scriptArgv.length > 0) {
    scriptArgv[0] = path.resolve(scriptArgv[0]);
  }

  console.warn(
    `[platform:${options.label}] required Node ${requiredVersion}, current ${currentVersion}. Re-running launcher with ${nodeBinaryPath}.`,
  );

  const result = spawnSync(nodeBinaryPath, scriptArgv, {
    cwd: process.cwd(),
    env: reexecEnvironment,
    stdio: "inherit",
  });

  if (result.signal) {
    process.kill(process.pid, result.signal);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
