/**
 * @fileoverview Verdent project-scope skill registration CLI entrypoint.
 * Owns the symlink pass that populates `.verdent/skills/` from `skills/`.
 * Agent-facing role: run directly to register all skills, or with `--skill <name>` for a single skill.
 *
 * Flow: parse argv → resolve repo root → delegate to `registerSkillsToTarget`
 * (prunes stale links, then creates new symlinks).
 *
 * @testing CLI: npx tsx scripts/canonical-agents/skills/register-verdent.ts && inspect .verdent/skills/ to confirm symlinks point into skills/.
 * @testing CLI: npx tsx scripts/canonical-agents/skills/register-verdent.ts --skill <skill-name>
 * @see scripts/canonical-agents/skills/register-shared.ts - Shared skill registration helper that owns symlink creation and stale-link pruning.
 * @see scripts/canonical-agents/skills/register-claude-project.ts - Sibling entrypoint that registers the same skills set into `.claude/skills/`.
 *
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import path from "node:path";
import process from "node:process";
import {
  parseCliOptions,
  registerSkillsToTarget,
} from "./register-shared";

/**
 * Registers canonical skills into `.verdent/skills/` for Verdent project-scope discovery.
 *
 * @remarks
 * I/O: resolves repository-relative paths then delegates to `registerSkillsToTarget` to prune stale
 * symlinks and create links into `skills/`.
 */
async function main(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv);
  const repositoryRootDirectoryPath: string = process.cwd();
  const verdentSkillsDirectoryPath: string = path.join(
    repositoryRootDirectoryPath,
    ".verdent",
    "skills",
  );

  await registerSkillsToTarget({
    repositoryRootDirectoryPath,
    requestedSkillNames: cliOptions.requestedSkillNames,
    targetSkillsDirectoryPath: verdentSkillsDirectoryPath,
    targetLabel: ".verdent/skills",
  });
}

main().catch((error: unknown) => {
  console.error(
    "Failed to register project-level skills for Verdent.",
  );
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
