/**
 * @fileoverview CLI entrypoint that populates `.claude/skills/` with symlinks into
 * `skills/` for Claude Code project-scope skill discovery. Owns the
 * registration pass for the Claude Code project-scope target directory.
 *
 * Flow: parse argv → resolve repo root → delegate to `registerSkillsToTarget`
 * (prunes stale links, then creates new symlinks).
 *
 * @testing CLI: npx tsx scripts/canonical-agents/skills/register-claude-project.ts && inspect .claude/skills/ to verify symlinks point into skills/.
 * @testing CLI: npx tsx scripts/canonical-agents/skills/register-claude-project.ts --skill <skill-name>
 *
 * @see scripts/canonical-agents/skills/register-shared.ts - Shared skill registration helper that owns symlink creation, stale-link pruning, and argv parsing.
 * @see scripts/canonical-agents/skills/register-dot-agents-project.ts - Sibling entrypoint that registers the same skills set into `.agents/skills/` for multi-harness discovery.
 *
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import path from "node:path";
import process from "node:process";
import { parseCliOptions, registerSkillsToTarget } from "./register-shared";

/**
 * Registers canonical skills into `.claude/skills/` for Claude Code project-scope discovery.
 *
 * @remarks
 * I/O: resolves repository-relative paths then delegates to `registerSkillsToTarget` to prune stale
 * symlinks and create links into `skills/`.
 */
async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv);
  const repositoryRootDirectoryPath: string = process.cwd();
  const claudeProjectSkillsDirectoryPath: string = path.join(
    repositoryRootDirectoryPath,
    ".claude",
    "skills",
  );

  await registerSkillsToTarget({
    repositoryRootDirectoryPath,
    requestedSkillNames: cliOptions.requestedSkillNames,
    targetSkillsDirectoryPath: claudeProjectSkillsDirectoryPath,
    targetLabel: ".claude/skills",
  });
}

main().catch((error: unknown) => {
  console.error(
    "Failed to register project-level skills for Claude Code (project scope).",
  );
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
