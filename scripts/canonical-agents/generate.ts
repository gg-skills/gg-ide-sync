#!/usr/bin/env -S npx tsx
/**
 * @fileoverview CLI entrypoint that discovers canonical agent and command definitions and syncs
 * them into IDE-native agent directories.
 *
 * This file owns the agent-generation orchestration loop: discovery of canonical agents,
 * subagents, overrides, and commands; target building; and
 * the sync pass that writes or validates generated IDE agent files.
 * Flow: discover agents/subagents/overrides/commands -> resolve workstation profile ->
 * build targets -> sync agents -> sync commands -> emit summary.
 *
 * @testing CLI: npx tsx scripts/canonical-agents/generate.ts --check
 * @testing CLI: npx tsx scripts/canonical-agents/generate.ts --write
 * @testing CLI manual: run `npm run agents:sync` from the repo root to invoke `--write` via the npm-script wrapper.
 *
 * @see scripts/canonical-agents/lib.ts - Shared generation helpers and sync implementations consumed by this CLI entrypoint.
 * @see canonical-agents/primary-agents/ - Source directory for canonical agent markdown definitions discovered and projected by this script.
 * @see canonical-agents/commands/ - Source directory for canonical command markdown definitions discovered and projected by this script.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import path from "node:path";

import {
  buildAgentTargets,
  discoverCanonicalAgents,
  discoverCommands,
  discoverOverrides,
  syncAgents,
  syncCommands,
  type AgentGenerationContext,
} from "./lib";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const repoRoot = process.cwd();
const AGENTIC_DIR = path.join(repoRoot, "canonical-agents");
const AGENTS_DIR = path.join(AGENTIC_DIR, "primary-agents");
const SUBAGENTS_DIR = path.join(AGENTIC_DIR, "subagents");
const OVERRIDES_DIR = path.join(AGENTIC_DIR, "overrides");
const COMMANDS_DIR = path.join(AGENTIC_DIR, "commands");
const AUGMENT_COMMANDS_DIR = path.join(repoRoot, ".augment", "commands");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const VERBOSE =
  process.env.SYNC_VERBOSE === "1" ||
  process.env.WORKFLOWS_SYNC_VERBOSE === "1";

/**
 * Emits a timestamped `[sync-agents]` line to stdout or stderr for operator visibility.
 *
 * @remarks
 * I/O: uses `console.log`, `console.warn`, or `console.error` depending on severity.
 * USAGE: passed into `syncAgents` / `syncCommands` as the shared diagnostic sink for this CLI run.
 *
 * @param message - Human-readable diagnostic text (no trailing newline required).
 * @param type - Severity channel; defaults to info-level stdout.
 */
function log(message: string, type: "info" | "warn" | "error" = "info"): void {
  const prefix = "[sync-agents]";
  const ts = new Date().toISOString();
  switch (type) {
    case "info":
      console.log(`${prefix} [INFO] ${ts} - ${message}`);
      break;
    case "warn":
      console.warn(`${prefix} [WARN] ${ts} - ${message}`);
      break;
    case "error":
      console.error(`${prefix} [ERROR] ${ts} - ${message}`);
      break;
  }
}

/**
 * Logs a message only when verbose mode is enabled via env flags.
 *
 * @remarks
 * PRE-CONDITION: `VERBOSE` is true when `SYNC_VERBOSE=1` or `WORKFLOWS_SYNC_VERBOSE=1`.
 * PURITY: no output when verbose mode is off.
 *
 * @param message - Diagnostic text forwarded to `log` at info level when verbose is active.
 */
function logVerbose(message: string): void {
  if (VERBOSE) {
    log(message);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const mode = args.includes("--write")
  ? ("write" as const)
  : args.includes("--check")
    ? ("check" as const)
    : ("dry-run" as const);

log(`Agent generation — mode: ${mode}`);
logVerbose(`Repo root: ${repoRoot}`);

// 1. Discover canonical agents
const agents = discoverCanonicalAgents(AGENTS_DIR, SUBAGENTS_DIR);
logVerbose(`Discovered ${agents.length} canonical agents (${AGENTS_DIR}, ${SUBAGENTS_DIR})`);

// 2. Discover overrides
const overrides = discoverOverrides(OVERRIDES_DIR);
const overrideCounts = Array.from(overrides.entries()).map(
  ([tool, map]) => `${tool}=${map.size}`,
);
logVerbose(`Discovered overrides: ${overrideCounts.join(", ")}`);

// 3. Discover commands
const commands = discoverCommands(COMMANDS_DIR);
logVerbose(`Discovered ${commands.length} canonical commands`);

// 4. Build targets
const targets = buildAgentTargets(repoRoot);
logVerbose(`Targets: ${targets.map((t) => t.name).join(", ")}`);

const generationContext: AgentGenerationContext = {
  semanticCodeSearch: {
    fallback: "rg",
    kind: "fallback",
  },
};
logVerbose("Semantic code search: rg");

// 5. Sync agents
logVerbose("=== Agents ===");
const agentResult = syncAgents(
  agents,
  overrides,
  targets,
  mode,
  generationContext,
  log,
  { verbose: VERBOSE },
);

// 6. Sync commands
logVerbose("=== Commands ===");
const cmdResult = syncCommands(commands, AUGMENT_COMMANDS_DIR, mode, log, {
  verbose: VERBOSE,
});

// 7. Summary
const totalGenerated = agentResult.generated + cmdResult.generated;
const totalWritten = agentResult.written + cmdResult.written;
const totalUnchanged = agentResult.unchanged + cmdResult.unchanged;
const totalDrift = agentResult.driftDetected + cmdResult.driftDetected;
const totalErrors = agentResult.errors + cmdResult.errors;

if (mode === "write") {
  log(
    `Summary: ${totalGenerated} files (changed: ${totalWritten}, unchanged: ${totalUnchanged}, errors: ${totalErrors})`,
  );
} else {
  log(
    `Summary: ${totalGenerated} files (drift: ${totalDrift}, errors: ${totalErrors})`,
  );
}

if (mode === "check" && totalDrift > 0) {
  log("Drift detected — run `npm run agents:sync` to sync", "error");
  process.exit(1);
}

if (totalErrors > 0) {
  log(`${totalErrors} errors encountered`, "error");
  process.exit(1);
}
