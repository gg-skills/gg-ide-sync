/**
 * @fileoverview CLI entrypoint that populates `.augment/skills/` with symlinks into
 * `skills/` for Auggie CLI and Intent skill discovery.
 *
 * This file owns the registration pass for the Auggie/Intent target directory.
 * Flow: parse argv -> resolve repo root -> delegate to `registerSkillsToTarget`
 * (which prunes stale links then creates new symlinks).
 *
 * @testing CLI: npx tsx scripts/canonical-agents/skills/register-auggie.ts from the repo root to register all skills; inspect `.augment/skills/` to verify symlinks point into `skills/`.
 * @testing CLI: npx tsx scripts/canonical-agents/skills/register-auggie.ts --skill <skill-name> to register a single skill by name.
 *
 * @see scripts/canonical-agents/skills/register-shared.ts - Shared skill registration helper that owns symlink creation, stale-link pruning, and argv parsing used by this entrypoint.
 * @see scripts/canonical-agents/skills/register-claude-project.ts - Sibling entrypoint that registers the same skills set into `.claude/skills/` for Claude Code discovery.
 * @see docs/IDE_SKILLS.md - Authority document that lists the Auggie/Intent skill registration command and target directory contract.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import path from "node:path";
import process from "node:process";

import {
  parseCliOptions,
  registerSkillsToTarget,
} from "./register-shared";

/**
 * Registers canonical skills into `.augment/skills/` for Auggie CLI and Intent discovery.
 *
 * @remarks
 * I/O: resolves repository-relative paths then delegates to `registerSkillsToTarget` to prune stale
 * symlinks and create links into `skills/`.
 */
async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv);
  const repositoryRootDirectoryPath = process.cwd();
  const augmentSkillsDirectoryPath = path.join(
    repositoryRootDirectoryPath,
    ".augment",
    "skills",
  );

  await registerSkillsToTarget({
    repositoryRootDirectoryPath,
    requestedSkillNames: cliOptions.requestedSkillNames,
    targetSkillsDirectoryPath: augmentSkillsDirectoryPath,
    targetLabel: ".augment/skills",
  });
}

main().catch((error: unknown) => {
  console.error(
    "Failed to register project-level skills for Auggie CLI and Intent.",
  );
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
