/**
 * @fileoverview CLI entrypoint that populates `.pi/skills/` with symlinks into `skills/` for Pi project-scope skill discovery.
 *
 * This file owns the registration pass for the Pi project-scope target directory.
 * Flow: parse argv -> resolve repo root -> delegate to `registerSkillsToTarget` (which prunes stale links then creates new symlinks).
 *
 * @testing CLI: npx tsx scripts/canonical-agents/skills/register-pi.ts from the repo root to register all skills; inspect `.pi/skills/` to verify symlinks point into `skills/`.
 * @testing CLI: npx tsx scripts/canonical-agents/skills/register-pi.ts --skill <skill-name> to register a single skill by name.
 *
 * @see scripts/canonical-agents/skills/register-shared.ts - Shared skill registration helper that owns symlink creation, stale-link pruning, and argv parsing used by this entrypoint.
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
 * Registers canonical skills into `.pi/skills/` for Pi project-scope discovery.
 *
 * @remarks
 * I/O: resolves repository-relative paths then delegates to `registerSkillsToTarget` to prune stale
 * symlinks and create links into `skills/`.
 */
async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv);
  const repositoryRootDirectoryPath: string = process.cwd();
  const piSkillsDirectoryPath: string = path.join(
    repositoryRootDirectoryPath,
    ".pi",
    "skills",
  );

  await registerSkillsToTarget({
    repositoryRootDirectoryPath,
    requestedSkillNames: cliOptions.requestedSkillNames,
    targetSkillsDirectoryPath: piSkillsDirectoryPath,
    targetLabel: ".pi/skills",
  });
}

main().catch((error: unknown) => {
  console.error("Failed to register project-level skills for Pi.");
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
