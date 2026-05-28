/**
 * @fileoverview CLI entrypoint that populates `.agents/skills/` with symlinks from `skills/` for multi-harness project-scope skill discovery.
 *
 * This file owns the `.agents/skills/` registration path consumed by OpenAI Codex CLI (native project discovery), Google Antigravity (workspace auto-discovery), and Kimi CLI v0.79+ (generic-group auto-discovery). Skill filtering via `--skill` / `--skills` flags is delegated to `register-shared`.
 *
 * @testing CLI: npx tsx scripts/canonical-agents/skills/register-dot-agents-project.ts from the repo root to register all skills; inspect `.agents/skills/` to verify symlinks point into `skills/`.
 * @testing CLI: npx tsx scripts/canonical-agents/skills/register-dot-agents-project.ts --skill <skill-name> to register a single skill by name.
 *
 * @see scripts/canonical-agents/skills/register-shared.ts - Shared symlink-registration helper that owns skill discovery, filtering, pruning, and linking logic called by this entrypoint.
 * @see scripts/canonical-agents/skills/register-claude-project.ts - Sibling entrypoint that registers the same skills set into `.claude/skills/` for Claude Code project scope.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import path from "node:path";
import process from "node:process";
import {
  parseCliOptions,
  registerSkillsToTarget,
} from "./register-shared";

/**
 * Registers canonical skills into `.agents/skills/` for multi-harness project-scope discovery.
 *
 * @remarks
 * I/O: resolves repository-relative paths then delegates to `registerSkillsToTarget` to prune stale
 * symlinks and create links into `skills/`.
 */
async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv);
  const repositoryRootDirectoryPath: string = process.cwd();
  const dotAgentsSkillsDirectoryPath: string = path.join(
    repositoryRootDirectoryPath,
    ".agents",
    "skills",
  );

  await registerSkillsToTarget({
    repositoryRootDirectoryPath,
    requestedSkillNames: cliOptions.requestedSkillNames,
    targetSkillsDirectoryPath: dotAgentsSkillsDirectoryPath,
    targetLabel: ".agents/skills",
  });
}

main().catch((error: unknown) => {
  console.error(
    "Failed to register project-level skills at .agents/skills/.",
  );
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
