/**
 * @fileoverview Resolves the Git repository root for ide-sync platform scripts with a
 * `process.cwd()` fallback when Git metadata is unavailable.
 *
 * This file owns the exported helper used to anchor filesystem paths to the monorepo checkout.
 * Flow: `git rev-parse --show-toplevel` -> trimmed path on success; otherwise return cwd.
 *
 * @example
 * ```typescript
 * import { resolveRepoRoot } from "./orchestration.js";
 *
 * const repoRoot = resolveRepoRoot();
 * ```
 *
 * @testing CLI: npx eslint skills/ide-sync/scripts/platform/lib/orchestration.ts
 * @testing CLI: npm run check:typescript-file-overview-errors
 *
 * @see skills/ide-sync/scripts/platform/commands/sync-submodule-packages.ts - Submodule package sync entrypoint that imports resolveRepoRoot so disk paths stay rooted in the checkout.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - Contract for file-overview headers, tag order, and verification metadata used by this module.
 * @documentation reviewed=2026-05-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { execSync } from "node:child_process";

/** Resolve the target repository root using Git, falling back to `process.cwd()`. */
export function resolveRepoRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}
