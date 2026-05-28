#!/usr/bin/env -S npx tsx

/**
 * @fileoverview CLI entrypoint and reusable API for canonical IDE rule synchronization.
 * Owned by the canonical-rules projection pipeline.
 *
 * Reads committed `canonical-rules/*.md` sources and projects them into native IDE rule
 * folders (Cursor, Windsurf, Antigravity, Trae) using the `generated-rules--` ownership
 * prefix. Flow: load rules → render targets → dry-run report or prefix-scoped write.
 *
 * @example
 * ```ts
 * import { syncCanonicalRules } from "./sync-canonical";
 *
 * // Preview changes without writing
 * syncCanonicalRules({ dryRun: true, repoRoot: process.cwd() });
 * ```
 *
 * @testing Jest with --experimental-vm-modules: npx jest --config jest.config.ts scripts/__tests__/canonical-rules.unit.test.ts
 * @see scripts/canonical-rules/rule-schema.ts - Canonical rule schema and parser.
 * @see scripts/canonical-rules/targets.ts - Target renderer matrix for Cursor, Windsurf, Antigravity, and Trae.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import path from "node:path";

import { loadCanonicalRules } from "./rule-schema";
import {
  CANONICAL_RULE_OUTPUT_PREFIX,
  CANONICAL_RULE_TARGETS,
  renderCanonicalRuleOutputs,
  type CanonicalRuleTarget,
  type CanonicalRuleTargetOutput,
} from "./targets";

const LEGACY_CANONICAL_RULE_OUTPUT_PREFIX = "canonical-rule--";

/** Options controlling dry-run versus write behavior and repository root resolution. */
export type SyncCanonicalRulesOptions = {
  dryRun: boolean;
  repoRoot: string;
};

/** Counts returned after preparing rules and target projections for logging or tests. */
export type SyncCanonicalRulesResult = {
  outputCount: number;
  ruleCount: number;
  targetCount: number;
};

const VERBOSE =
  process.env.SYNC_VERBOSE === "1" ||
  process.env.WORKFLOWS_SYNC_VERBOSE === "1";

/**
 * Emits a prefixed, timestamped diagnostic line routed by severity.
 *
 * @remarks
 * I/O: uses `console.error` for errors, `console.warn` for warnings, otherwise `console.log`.
 *
 * @param message - Human-readable operator-facing line without the shared prefix.
 * @param type - Chooses the stdio routing and log level label for the emitted line.
 */
function log(message: string, type: "info" | "warn" | "error" = "info"): void {
  const prefix = "[rules:sync:canonical]";
  const timestamp = new Date().toISOString();
  const line = `${prefix} [${type.toUpperCase()}] ${timestamp} - ${message}`;

  if (type === "error") {
    console.error(line);
    return;
  }

  if (type === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

/**
 * Forwards informational messages through `log` only when synchronous verbose toggles are on.
 *
 * @remarks
 * USAGE: honors `VERBOSE` derived from `SYNC_VERBOSE` and `WORKFLOWS_SYNC_VERBOSE` env vars.
 *
 * @param message - Payload passed through to `log` when verbosity is enabled.
 */
function logVerbose(message: string): void {
  if (VERBOSE) {
    log(message);
  }
}

/**
 * Converts path segments delimited by the host separator into a POSIX `/`-joined representation.
 *
 * @remarks
 * PURITY: string split/join only; preserves relative-vs-absolute shape implied by inputs.
 *
 * @param filePath - Path fragments joined using the current platform separator before normalization.
 */
function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * Ensures `directoryPath` exists, creating ancestors recursively when absent.
 *
 * @remarks
 * I/O: `fs.mkdirSync` with `recursive`; logs once when the directory is newly created.
 *
 * @param directoryPath - Filesystem folder that must exist before writing projections.
 */
function ensureDirectoryExists(directoryPath: string): void {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
    // Created NEW directory is a state change — always emit.
    log(`Created directory: ${directoryPath}`);
  }
}

/**
 * Seeds an empty `.gitkeep` anchor so empty canonical rule target folders stay tracked in git.
 *
 * @remarks
 * I/O: synchronously writes an empty UTF-8 file via `writeFileSync` when missing.
 *
 * @param directoryPath - Folder that receives the `.gitkeep` anchor sibling to projection files.
 */
function ensureGitkeep(directoryPath: string): void {
  const gitkeepPath = path.join(directoryPath, ".gitkeep");
  if (!fs.existsSync(gitkeepPath)) {
    fs.writeFileSync(gitkeepPath, "", "utf8");
    log(`Created target folder anchor: ${gitkeepPath}`);
  }
}

/**
 * Buckets flattened projection outputs keyed by canonical target for stable downstream iteration.
 *
 * @remarks
 * Iterates `CANONICAL_RULE_TARGETS` so traversal order mirrors the authoritative matrix ordering.
 *
 * @param outputs - Rendered filenames and bodies produced for every active IDE projection.
 * @returns Map assigning each canonical target slice to outputs targeting that IDE surface only.
 */
function groupOutputsByTarget(
  outputs: CanonicalRuleTargetOutput[],
): Map<CanonicalRuleTarget, CanonicalRuleTargetOutput[]> {
  const groupedOutputs = new Map<CanonicalRuleTarget, CanonicalRuleTargetOutput[]>();

  for (const target of CANONICAL_RULE_TARGETS) {
    groupedOutputs.set(
      target,
      outputs.filter((output) => output.target.id === target.id),
    );
  }

  return groupedOutputs;
}

/**
 * Prints a dry-run report listing each target directory and its projected rule filenames.
 *
 * @remarks
 * I/O: stdio logging only; never touches the filesystem.
 *
 * @param outputs - Rendered outputs that would be written when `dryRun` is false.
 */
function showDryRun(outputs: CanonicalRuleTargetOutput[]): void {
  log("DRY RUN - canonical rule sync");

  for (const [target, targetOutputs] of groupOutputsByTarget(outputs)) {
    log(`Target: ${target.name} -> ${target.directory}`);
    for (const output of targetOutputs) {
      log(`  - ${output.relativePath}`);
    }
  }
}

/**
 * Removes orphaned generated canonical rule filenames that are no longer part of the projection.
 *
 * @remarks
 * I/O: deletes only files prefixed with {@link CANONICAL_RULE_OUTPUT_PREFIX} or legacy
 * `canonical-rule--`; skips non-files, non-owned filenames, and basenames retained in expectations.
 *
 * @param directoryPath - Absolute target directory scanned for stale owned outputs.
 * @param expectedFilenames - Basenames that must remain because they appear in the current render.
 * @returns Count of successfully unlinked stale files.
 */
function clearStaleOwnedFiles(
  directoryPath: string,
  expectedFilenames: Set<string>,
): number {
  if (!fs.existsSync(directoryPath)) {
    return 0;
  }
  let removedCount = 0;
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const isOwned =
      entry.name.startsWith(CANONICAL_RULE_OUTPUT_PREFIX) ||
      entry.name.startsWith(LEGACY_CANONICAL_RULE_OUTPUT_PREFIX);
    if (!isOwned) {
      continue;
    }
    if (expectedFilenames.has(entry.name)) {
      continue;
    }
    fs.unlinkSync(path.join(directoryPath, entry.name));
    removedCount += 1;
  }
  return removedCount;
}

/**
 * Writes rendered outputs per IDE target dir, skips unchanged files, prunes stale owned rules.
 *
 * @remarks
 * I/O: ensures directories/gitkeep anchors, unlink stale prefixed files, reads prior bytes for diff,
 * writes UTF-8 when content differs, emits summary logs per target slice.
 *
 * @param repoRoot - Absolute checkout root resolving `output.relativePath` locations.
 * @param outputs - Full projection manifest spanning every configured canonical target.
 */
function writeTargetOutputs(
  repoRoot: string,
  outputs: CanonicalRuleTargetOutput[],
): void {
  for (const [target, targetOutputs] of groupOutputsByTarget(outputs)) {
    const targetDirectoryPath = path.join(repoRoot, target.directory);
    ensureDirectoryExists(targetDirectoryPath);
    ensureGitkeep(targetDirectoryPath);

    const expectedFilenames = new Set(
      targetOutputs.map((output) => path.basename(output.relativePath)),
    );
    const staleRemoved = clearStaleOwnedFiles(
      targetDirectoryPath,
      expectedFilenames,
    );
    if (staleRemoved > 0) {
      log(
        `Removed ${staleRemoved} stale canonical rule file(s) from ${target.directory}`,
      );
    }

    let changedCount = 0;
    let createdCount = 0;
    for (const output of targetOutputs) {
      const outputPath = path.join(repoRoot, output.relativePath);
      const isExisting = fs.existsSync(outputPath);
      const priorContent = isExisting
        ? fs.readFileSync(outputPath, "utf8")
        : null;
      const isChanged = priorContent !== output.content;

      if (isChanged) {
        fs.writeFileSync(outputPath, output.content, "utf8");
        if (isExisting) {
          changedCount += 1;
        } else {
          createdCount += 1;
        }
        const verb = isExisting ? "Updated" : "Wrote";
        logVerbose(
          `${verb} ${target.name} rule: ${toPosixPath(path.relative(repoRoot, outputPath))}`,
        );
      } else {
        logVerbose(
          `${target.name} rule: ${toPosixPath(path.relative(repoRoot, outputPath))} ✓ (up to date)`,
        );
      }
    }

    const totalChanges = changedCount + createdCount;
    if (totalChanges === 0 && staleRemoved === 0) {
      log(`${target.name}: no changes (${targetOutputs.length} rules already up to date)`);
    } else {
      log(
        `${target.name}: ${targetOutputs.length} rules (created: ${createdCount}, updated: ${changedCount}, removed: ${staleRemoved})`,
      );
    }
  }
}

/**
 * Loads canonical rules, renders IDE projections, and either prints a dry-run plan or writes files.
 *
 * @remarks
 * I/O: reads `canonical-rules/*.md`, may create directories, `.gitkeep`, delete prior
 * `generated-rules--*` and legacy `canonical-rule--*` files, and write refreshed outputs when
 * `dryRun` is false. Logs progress to stdio.
 */
export function syncCanonicalRules(options: SyncCanonicalRulesOptions): SyncCanonicalRulesResult {
  const rules = loadCanonicalRules(options.repoRoot);
  const outputs = renderCanonicalRuleOutputs(rules);

  logVerbose(`Prepared ${rules.length} canonical rule file(s).`);
  logVerbose(`Prepared ${outputs.length} target rule projection(s).`);

  if (rules.length === 0) {
    log("No canonical rule files were found.", "warn");
  }

  if (options.dryRun) {
    showDryRun(outputs);
  } else {
    writeTargetOutputs(options.repoRoot, outputs);
    logVerbose("Canonical rule sync complete.");
  }

  return {
    outputCount: outputs.length,
    ruleCount: rules.length,
    targetCount: CANONICAL_RULE_TARGETS.length,
  };
}

/**
 * Executable entry shim: parses argv for `--write`, runs sync under cwd, forwards failures as exit 1.
 *
 * @remarks
 * Defaults to dry-run whenever `--write` is absent; sets `process.exitCode` rather than exiting inside
 * the try block after logging surfaced errors via `log`.
 */
function main(): void {
  const dryRun = !process.argv.includes("--write");
  try {
    syncCanonicalRules({
      dryRun,
      repoRoot: process.cwd(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log(message, "error");
    process.exitCode = 1;
  }
}

main();
