#!/usr/bin/env -S npx tsx
/**
 * @fileoverview CLI entrypoint for the agents-guidance sync script.
 *
 * Owned by the root-repo scripts layer. Materializes AI-agent guidance targets (e.g., Codex) by
 * generating `AGENTS.CODEX.md` and keeping `.codex/config.toml` pointed at it through
 * `model_instructions_file`. Called by agents via `npm run agents:sync`.
 *
 * @example
 * ```bash
 * # Dry-run (default)
 * npx tsx scripts/agents-guidance/generate.ts
 *
 * # Write changes
 * npx tsx scripts/agents-guidance/generate.ts --write
 *
 * # Check for drift
 * npx tsx scripts/agents-guidance/generate.ts --check
 * ```
 *
 * @testing CLI manual: npm run agents:sync
 * @see scripts/agents-guidance/lib.ts - Shared sync helpers and target-specific renderers.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import {
  parseAgentsGuidanceTargetIds,
  syncAgentsGuidance,
  type AgentsGuidanceMode,
} from "./lib";

/**
 * Derives the agents-guidance sync mode from CLI arguments.
 *
 * @remarks
 * `--write` is evaluated before `--check`, so both flags favor `write`.
 *
 * @param argv - Process arguments after the script path (`process.argv` slice).
 * @returns Effective sync mode for `syncAgentsGuidance`.
 */
function resolveMode(argv: string[]): AgentsGuidanceMode {
  if (argv.includes("--write")) {
    return "write";
  }

  if (argv.includes("--check")) {
    return "check";
  }

  return "dry-run";
}

const VERBOSE =
  process.env.SYNC_VERBOSE === "1" ||
  process.env.WORKFLOWS_SYNC_VERBOSE === "1";

/**
 * Emits a timestamped agents-guidance log line to the console.
 *
 * @remarks
 * Writes informational lines to stdout and error lines to stderr using a shared prefix.
 *
 * @param message - Human-readable payload appended after the timestamp.
 * @param type - Chooses stderr vs stdout and the severity token in the log prefix.
 */
function log(message: string, type: "error" | "info" = "info"): void {
  const prefix = "[agents-guidance]";
  const timestamp = new Date().toISOString();
  const write = type === "error" ? console.error : console.log;
  write(`${prefix} [${type.toUpperCase()}] ${timestamp} - ${message}`);
}

/**
 * Logs only when verbose tracing is enabled for sync tooling.
 *
 * @remarks
 * Active when `SYNC_VERBOSE` or `WORKFLOWS_SYNC_VERBOSE` is set to `1`.
 *
 * @param message - Payload forwarded to `log` when verbose mode is on.
 */
function logVerbose(message: string): void {
  if (VERBOSE) {
    log(message);
  }
}

/**
 * CLI entry: resolves mode and repo root, runs `syncAgentsGuidance`, then prints per-target output.
 *
 * @remarks
 * Exits with code `1` when any target reports errors or when `check` mode detects drift.
 */
function main(): void {
  const argv = process.argv.slice(2);
  const mode = resolveMode(argv);
  const repoRoot = process.cwd();
  const targetIds = parseAgentsGuidanceTargetIds(argv);

  logVerbose(`Agents guidance sync — mode: ${mode}`);
  logVerbose(`Repo root: ${repoRoot}`);
  logVerbose(`Targets: ${targetIds.join(", ")}`);

  const report = syncAgentsGuidance({
    mode,
    repoRoot,
    targetIds,
  });

  for (const targetReport of report.targets) {
    if (targetReport.errors.length > 0) {
      log(`Target ${targetReport.targetId}`);
      for (const error of targetReport.errors) {
        log(`  error: ${error}`, "error");
      }
      continue;
    }
    if (targetReport.changes.length === 0) {
      logVerbose(`Target ${targetReport.targetId}: no changes`);
    } else {
      log(`Target ${targetReport.targetId}`);
      for (const change of targetReport.changes) {
        log(`  ${change}`);
      }
    }
  }

  // Single-line summary: only emit when changes/drift/errors > 0 or in verbose.
  if (
    report.totalChanges > 0 ||
    report.totalDriftDetected > 0 ||
    report.totalErrors > 0
  ) {
    log(
      `Summary: changes=${report.totalChanges}, drift=${report.totalDriftDetected}, errors=${report.totalErrors}`,
    );
  } else {
    logVerbose(
      `Summary: changes=${report.totalChanges}, drift=${report.totalDriftDetected}, errors=${report.totalErrors}`,
    );
  }

  if (report.totalErrors > 0) {
    process.exit(1);
  }

  if (mode === "check" && report.totalDriftDetected > 0) {
    log("Drift detected — run `npm run agents:sync` to sync.", "error");
    process.exit(1);
  }
}

main();
