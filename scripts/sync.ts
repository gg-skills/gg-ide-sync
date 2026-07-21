#!/usr/bin/env -S npx tsx
/**
 * @fileoverview Portable IDE sync orchestrator for repository guidance, skills, workflows, rules, and package submodule sync lanes.
 *
 * Flow: resolve the target repository from `process.cwd()` -> select one or more sync lanes -> run the
 * skill-owned projection scripts in the same order as the root `npm run sync` contract -> stop on the
 * first failing command with the child exit code.
 *
 * @testing CLI: npx tsx .agents/skills/ide-sync/scripts/sync.ts --dry-run
 * @testing CLI: npx tsx .agents/skills/ide-sync/scripts/sync.ts --lane skills
 * @see skills/ide-sync/SKILL.md - Operator workflow and lane descriptions.
 * @documentation reviewed=2026-05-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Named IDE sync lane the CLI can select explicitly or inherit via the default full run.
 *
 * @remarks
 * Lane order in argv is preserved; the orchestrator still runs each lane's commands in the contract order below.
 */
type SyncLane = "skills" | "agents" | "workflows" | "rules" | "submodules";

/**
 * One synchronous child-process invocation the orchestrator runs from the target repository root.
 *
 * @remarks
 * `optionalWhenMissing` allows skipping commands when a repo lacks optional fixtures (for example, submodule-only tests).
 */
type SyncCommand = {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  optionalWhenMissing?: string;
};

const ALL_LANES: SyncLane[] = ["skills", "agents", "workflows", "rules", "submodules"];
const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY_PATH = path.dirname(CURRENT_FILE_PATH);

/**
 * Collects `--lane` / `--lane=` selections from argv, defaulting to every lane when none are provided.
 *
 * @remarks
 * Unknown lane tokens throw before any child processes start so failures stay deterministic and local to argv parsing.
 */
function parseLanes(argv: string[]): SyncLane[] {
  const selectedLanes: SyncLane[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--lane") {
      const lane = argv[index + 1];
      if (isSyncLane(lane)) {
        selectedLanes.push(lane);
        index += 1;
        continue;
      }
      throw new Error(`Unknown sync lane after --lane: ${lane ?? "<missing>"}`);
    }

    if (typeof token === "string" && token.startsWith("--lane=")) {
      const lane = token.slice("--lane=".length);
      if (isSyncLane(lane)) {
        selectedLanes.push(lane);
        continue;
      }
      throw new Error(`Unknown sync lane: ${lane}`);
    }
  }

  return selectedLanes.length > 0 ? selectedLanes : ALL_LANES;
}

/**
 * Narrows untrusted argv fragments to the closed `SyncLane` union.
 *
 * @remarks
 * `parseLanes` combines this guard with explicit throws so unknown lane tokens never reach orchestration.
 */
function isSyncLane(value: unknown): value is SyncLane {
  return typeof value === "string" && ALL_LANES.includes(value as SyncLane);
}

/**
 * Resolves helper script paths relative to this file's directory so `tsx` can load sibling tooling.
 */
function scriptPath(relativePath: string): string {
  return path.join(SCRIPT_DIRECTORY_PATH, relativePath);
}

/**
 * Joins repository-relative paths against `repoRoot` while leaving absolute inputs untouched.
 */
function targetPath(repoRoot: string, candidatePath: string): string {
  return path.isAbsolute(candidatePath) ? candidatePath : path.join(repoRoot, candidatePath);
}

/**
 * Filesystem existence probe for paths interpreted from the active repository root.
 */
function exists(repoRoot: string, candidatePath: string): boolean {
  return fs.existsSync(targetPath(repoRoot, candidatePath));
}

/**
 * Builds a labeled `npx tsx <local-script> ...args` command for lane orchestration.
 */
function tsxCommand(label: string, relativeScriptPath: string, args: string[] = []): SyncCommand {
  return {
    args: ["tsx", scriptPath(relativeScriptPath), ...args],
    command: "npx",
    label,
  };
}

/**
 * Expands a lane into ordered child commands honoring dry-run vs write semantics and repo-specific skips.
 *
 * @remarks
 * Submodule lane returns an empty list when `.gitmodules` is absent; rules lane may attach `optionalWhenMissing` for optional tests.
 */
function buildCommandsForLane(options: { dryRun: boolean; lane: SyncLane; repoRoot: string }): SyncCommand[] {
  const writeFlag = options.dryRun ? [] : ["--write"];

  switch (options.lane) {
    case "skills":
      return [
        tsxCommand("skills icons", "skill-index/generate-skill-icons.ts"),
        tsxCommand("skills indexes", "skill-index/generate-skill-indexes.ts"),
        tsxCommand("skills register .agents", "canonical-agents/skills/register-dot-agents-project.ts"),
        tsxCommand("skills register Claude", "canonical-agents/skills/register-claude-project.ts"),
        tsxCommand("skills register Auggie", "canonical-agents/skills/register-auggie.ts"),
        tsxCommand("skills register pi", "canonical-agents/skills/register-pi.ts"),
        tsxCommand("skills register Verdent", "canonical-agents/skills/register-verdent.ts"),
      ];

    case "agents":
      return [
        tsxCommand("canonical agents", "canonical-agents/generate.ts", options.dryRun ? [] : ["--write"]),
        tsxCommand("agents guidance", "agents-guidance/generate.ts", options.dryRun ? [] : ["--write"]),
      ];

    case "workflows":
      return [
        tsxCommand("workflows npm", "canonical-workflows/sync-npm.ts", writeFlag),
        tsxCommand("workflows skills", "canonical-workflows/sync-skills.ts", writeFlag),
        tsxCommand("workflows submodule discovery", "canonical-workflows/sync-submodule-discovery.ts", writeFlag),
        tsxCommand("workflows IDE", "canonical-workflows/sync-ide.ts", writeFlag),
      ];

    case "rules":
      return [
        tsxCommand("rules documentation map", "docs-sync/sync-rules-documentation-map.ts", writeFlag),
        tsxCommand("rules canonical", "canonical-rules/sync-canonical.ts", writeFlag),
        {
          args: [
            "jest",
            "--config",
            scriptPath("../jest.config.ts"),
            scriptPath("__tests__/canonical-rules.unit.test.ts"),
          ],
          command: "npx",
          env: { ...process.env, NODE_OPTIONS: "--experimental-vm-modules" },
          label: "rules unit test",
          optionalWhenMissing: scriptPath("__tests__/canonical-rules.unit.test.ts"),
        },
      ];

    case "submodules":
      return exists(options.repoRoot, ".gitmodules")
        ? [tsxCommand("submodule package sync", "platform/commands/sync-submodule-packages.ts", options.dryRun ? ["--dry-run"] : [])]
        : [];
  }
}

/**
 * Runs one sync command synchronously with inherited stdio, honoring optional skip paths.
 *
 * @remarks
 * I/O: uses `spawnSync` from the target `repoRoot`; signals map to exit code `1` for operator visibility.
 */
function runCommand(command: SyncCommand, repoRoot: string): number {
  if (command.optionalWhenMissing && !exists(repoRoot, command.optionalWhenMissing)) {
    console.log(`[ide-sync] skip ${command.label}: ${command.optionalWhenMissing} not found`);
    return 0;
  }

  console.log(`[ide-sync] run ${command.label}`);
  const result = spawnSync(command.command, command.args, {
    cwd: repoRoot,
    env: command.env ?? process.env,
    stdio: "inherit",
  });

  if (result.signal) {
    console.error(`[ide-sync] ${command.label} stopped by signal ${result.signal}`);
    return 1;
  }

  return result.status ?? 0;
}

/**
 * CLI entry that sequences selected lanes, stopping on the first failing child exit status.
 *
 * @remarks
 * Treats `--check` as a dry-run alias; never swallows child exit codes except optional skips returning `0`.
 */
function main(): number {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || argv.includes("--check");
  const repoRoot = process.cwd();
  const lanes = parseLanes(argv);

  console.log(`[ide-sync] target repo: ${repoRoot}`);
  console.log(`[ide-sync] lanes: ${lanes.join(", ")}${dryRun ? " (dry-run)" : ""}`);

  for (const lane of lanes) {
    const commands = buildCommandsForLane({ dryRun, lane, repoRoot });
    if (commands.length === 0) {
      console.log(`[ide-sync] skip ${lane}: no matching source files`);
      continue;
    }

    for (const command of commands) {
      const status = runCommand(command, repoRoot);
      if (status !== 0) {
        console.error(`[ide-sync] failed: ${command.label}`);
        return status;
      }
    }
  }

  console.log("[ide-sync] complete");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ide-sync] ${message}`);
  process.exit(1);
}
