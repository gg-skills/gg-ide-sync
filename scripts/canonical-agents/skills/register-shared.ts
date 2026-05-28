/**
 * @fileoverview Shared skill registration helper for the skills sync pipeline.
 * Discovers skill directories under `skills/`, symlinks them into IDE-native
 * target directories, prunes stale links, and supports selective registration by name.
 *
 * @example
 * // Parse selective skill flags from argv
 * const { requestedSkillNames } = parseCliOptions(process.argv);
 *
 * // Link discovered skills into a target IDE skills directory
 * const summary = await registerSkillsToTarget({
 *   repositoryRootDirectoryPath: process.cwd(),
 *   requestedSkillNames,
 *   targetSkillsDirectoryPath: "./.kimi/skills",
 *   targetLabel: "kimi",
 * });
 *
 * @testing Manual CLI — run `npx tsx scripts/canonical-agents/skills/register-shared.ts` from the repo root.
 * @see docs/COMMANDS.md - npm scripts that invoke skill sync (`skills:sync`, `skills:manager:*`).
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** Outcome of attempting to symlink one skill into a target skills directory.
 * - `created`: a new symlink was added (no prior link existed).
 * - `refreshed`: a symlink existed but pointed elsewhere or was a non-link; rewritten.
 * - `unchanged`: a symlink already pointed at the correct skill source; no I/O.
 * - `skipped`: a non-symlink target exists at the path; left untouched.
 */
export type SkillLinkResult = "created" | "refreshed" | "unchanged" | "skipped";

const VERBOSE =
  process.env.SYNC_VERBOSE === "1" ||
  process.env.WORKFLOWS_SYNC_VERBOSE === "1";

/** Parsed argv flags selecting which skills to register. */
export interface CliOptions {
  requestedSkillNames: string[];
}

/** Repository paths for linking discovered skill directories into a writable target dir. */
export interface RegisterSkillsToTargetOptions {
  repositoryRootDirectoryPath: string;
  requestedSkillNames: string[];
  targetSkillsDirectoryPath: string;
}

/** Counts returned after a registration pass: found skills, new links, refreshed links, pruned stale links, skips. */
export interface RegistrationSummary {
  foundCount: number;
  /** Total of `created + refreshed + unchanged`; a no-op rerun has linkedCount === foundCount and addedCount === 0. */
  linkedCount: number;
  /** New symlinks added because no prior link existed. */
  addedCount: number;
  /** Symlinks rewritten because they pointed elsewhere or were not symlinks. */
  refreshedCount: number;
  /** Symlinks that already pointed at the correct skill source; not rewritten. */
  unchangedCount: number;
  removedStaleLinksCount: number;
  skippedCount: number;
}

/**
 * Reads a Node-style `code` field from an error-like value when present and string-typed.
 *
 * @remarks
 * PURITY: No I/O. USAGE: Narrow `unknown` catch values before branching on `"ENOENT"` and siblings.
 */
function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

/**
 * Adds trimmed non-empty skill names from a comma-separated argv fragment into the accumulator set.
 *
 * @remarks
 * PURITY: No I/O.
 */
function addCommaSeparatedSkillNames(options: {
  requestedSkillNames: Set<string>;
  commaSeparatedValue: string;
}): void {
  for (const item of options.commaSeparatedValue.split(",")) {
    const skillName = item.trim();
    if (skillName.length > 0) {
      options.requestedSkillNames.add(skillName);
    }
  }
}

/**
 * Parses `--skill`, `--skill=name`, `--skills`, and `--skills=a,b` argv forms into a de-duplicated list.
 *
 * @remarks
 * PURITY: No I/O. USAGE: Pass `process.argv` from skill registration CLIs.
 *
 * @example
 * parseCliOptions(["node", "script", "--skill=foo", "--skills", "bar,baz"]);
 * // => { requestedSkillNames: ["foo", "bar", "baz"] }
 */
export function parseCliOptions(argv: string[]): CliOptions {
  const requestedSkillNames = new Set<string>();

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--skill") {
      const nextValue = argv[index + 1];
      if (nextValue) {
        requestedSkillNames.add(nextValue.trim());
        index += 1;
      }
      continue;
    }

    if (argument.startsWith("--skill=")) {
      const value = argument.slice("--skill=".length).trim();
      if (value.length > 0) {
        requestedSkillNames.add(value);
      }
      continue;
    }

    if (argument === "--skills") {
      const nextValue = argv[index + 1];
      if (nextValue) {
        addCommaSeparatedSkillNames({
          requestedSkillNames,
          commaSeparatedValue: nextValue,
        });
        index += 1;
      }
      continue;
    }

    if (argument.startsWith("--skills=")) {
      const value = argument.slice("--skills=".length);
      addCommaSeparatedSkillNames({
        requestedSkillNames,
        commaSeparatedValue: value,
      });
    }
  }

  return {
    requestedSkillNames: [...requestedSkillNames],
  };
}

/**
 * Lists every `skills/<name>/SKILL.md` path that exists as a regular file.
 *
 * @remarks
 * I/O: Reads `skills/` directory entries and stats each candidate `SKILL.md`. Missing
 * files are skipped; non-ENOENT stat failures propagate.
 */
async function collectSkillFilePaths(options: {
  repositoryRootDirectoryPath: string;
}): Promise<string[]> {
  const skillsDirectoryPath = path.join(
    options.repositoryRootDirectoryPath,
    "skills",
  );
  const directoryEntries = await fs.readdir(skillsDirectoryPath, {
    withFileTypes: true,
  });

  const candidateSkillFilePaths = directoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDirectoryPath, entry.name, "SKILL.md"));

  const existingSkillFilePaths: string[] = [];

  for (const skillFilePath of candidateSkillFilePaths) {
    try {
      const skillFileStats = await fs.stat(skillFilePath);
      if (skillFileStats.isFile()) {
        existingSkillFilePaths.push(skillFilePath);
      }
    } catch (error: unknown) {
      if (getErrorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return existingSkillFilePaths;
}

/**
 * Returns whether the given path exists and is a directory.
 *
 * @remarks
 * I/O: Single `stat` of `projectSkillsDirectoryPath`. Treats ENOENT as absent (false); other
 * errors propagate.
 */
async function projectSkillsDirectoryExists(options: {
  projectSkillsDirectoryPath: string;
}): Promise<boolean> {
  try {
    const skillsDirectoryStats = await fs.stat(
      options.projectSkillsDirectoryPath,
    );
    return skillsDirectoryStats.isDirectory();
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Removes symlinks under the target skills dir that are broken or no longer map to a valid skill tree.
 *
 * @remarks
 * I/O: Reads the target directory, follows symlinks with `realpath`, stats expected `SKILL.md` under
 * `skills/`, and deletes stale links. Emits one line to stdout per removal. Returns the
 * number of symlinks removed.
 */
async function pruneBrokenSkillLinks(options: {
  repositoryRootDirectoryPath: string;
  targetSkillsDirectoryPath: string;
}): Promise<number> {
  const directoryEntries = await fs.readdir(options.targetSkillsDirectoryPath, {
    withFileTypes: true,
  });

  let removedCount = 0;

  for (const entry of directoryEntries) {
    if (!entry.isSymbolicLink()) {
      continue;
    }

    const linkPath = path.join(options.targetSkillsDirectoryPath, entry.name);

    try {
      await fs.stat(linkPath);
    } catch (error: unknown) {
      const errorCode = getErrorCode(error);
      if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
        await fs.rm(linkPath, { force: true });
        removedCount += 1;
        console.log(`Removed stale symlink '${entry.name}'`);
        continue;
      }
      throw error;
    }

    try {
      const resolvedLinkPath = await fs.realpath(linkPath);
      const repositorySkillsDirectoryPath = path.join(
        options.repositoryRootDirectoryPath,
        "skills",
      );
      const relativeTargetPath = path.relative(
        repositorySkillsDirectoryPath,
        resolvedLinkPath,
      );

      const resolvesInsideProjectSkills =
        relativeTargetPath.length > 0 &&
        !relativeTargetPath.startsWith("..") &&
        !path.isAbsolute(relativeTargetPath);

      if (!resolvesInsideProjectSkills) {
        continue;
      }

      const skillFilePath = path.join(resolvedLinkPath, "SKILL.md");
      try {
        const skillFileStats = await fs.stat(skillFilePath);
        if (skillFileStats.isFile()) {
          continue;
        }
      } catch (error: unknown) {
        const errorCode = getErrorCode(error);
        if (errorCode !== "ENOENT" && errorCode !== "ENOTDIR") {
          throw error;
        }
      }

      await fs.rm(linkPath, { force: true });
      removedCount += 1;
      console.log(
        `Removed stale symlink '${entry.name}' (source no longer contains SKILL.md)`,
      );
    } catch (error: unknown) {
      const errorCode = getErrorCode(error);
      if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
        await fs.rm(linkPath, { force: true });
        removedCount += 1;
        console.log(`Removed stale symlink '${entry.name}'`);
        continue;
      }
      throw error;
    }
  }

  return removedCount;
}

/**
 * Ensures a directory symlink exists from the target skills dir to the skill folder for one SKILL.md path.
 *
 * @remarks
 * I/O: `lstat` / `readlink` / `rm` / `symlink` on the per-skill link. Logs WARN when the target path
 * is occupied by a non-symlink; verbose success lines respect SYNC_VERBOSE. Returns whether the link
 * was created, refreshed, left correct, or skipped.
 */
async function createSkillLink(options: {
  skillFilePath: string;
  targetSkillsDirectoryPath: string;
}): Promise<SkillLinkResult> {
  const skillDirectoryPath = path.dirname(options.skillFilePath);
  const skillName = path.basename(skillDirectoryPath);
  const targetLinkPath = path.join(
    options.targetSkillsDirectoryPath,
    skillName,
  );
  const symlinkTargetPath = path.relative(
    path.dirname(targetLinkPath),
    skillDirectoryPath,
  );

  let priorState: "missing" | "wrong-symlink" | "non-symlink" | "correct" =
    "missing";

  try {
    const targetStats = await fs.lstat(targetLinkPath);
    if (!targetStats.isSymbolicLink()) {
      // ALWAYS warn: a non-symlink at the target path is a state mismatch the
      // user needs to know about. WARN is never gated by verbosity.
      console.warn(
        `[skills:sync] WARN Skipping '${skillName}': target exists and is not a symlink (${targetLinkPath})`,
      );
      return "skipped";
    }

    const existingTarget = await fs.readlink(targetLinkPath);
    if (existingTarget === symlinkTargetPath) {
      priorState = "correct";
    } else {
      priorState = "wrong-symlink";
    }
  } catch (error: unknown) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
    priorState = "missing";
  }

  if (priorState === "correct") {
    if (VERBOSE) {
      console.log(`[skills:sync] '${skillName}' ✓ (up to date)`);
    }
    return "unchanged";
  }

  if (priorState === "wrong-symlink") {
    await fs.rm(targetLinkPath, { force: true });
  }

  await fs.symlink(symlinkTargetPath, targetLinkPath, "dir");

  if (priorState === "missing") {
    // State change: always emit.
    console.log(`[skills:sync] Linked '${skillName}' -> ${skillDirectoryPath}`);
    return "created";
  }
  // wrong-symlink → rewritten
  console.log(
    `[skills:sync] Refreshed '${skillName}' -> ${skillDirectoryPath}`,
  );
  return "refreshed";
}

/**
 * Restricts discovered skill file paths to an explicit whitelist, or returns all paths when the list is empty.
 *
 * @remarks
 * I/O: Logs the filter set to stdout when selective. Throws an Error listing missing and available
 * skill names when a requested name does not exist under `skills/`.
 */
function filterSkillFilePaths(options: {
  requestedSkillNames: string[];
  skillFilePaths: string[];
}): string[] {
  if (options.requestedSkillNames.length === 0) {
    return options.skillFilePaths;
  }

  const availableSkillNames = new Set(
    options.skillFilePaths.map((skillFilePath) =>
      path.basename(path.dirname(skillFilePath)),
    ),
  );
  const missingSkillNames = options.requestedSkillNames.filter(
    (skillName) => !availableSkillNames.has(skillName),
  );

  if (missingSkillNames.length > 0) {
    throw new Error(
      `Requested skill(s) not found: ${missingSkillNames.join(", ")}. Available skills: ${[
        ...availableSkillNames,
      ]
        .sort()
        .join(", ")}`,
    );
  }

  const requestedSet = new Set(options.requestedSkillNames);
  console.log(
    `Filtering registration to: ${options.requestedSkillNames.join(", ")}`,
  );

  return options.skillFilePaths.filter((skillFilePath) =>
    requestedSet.has(path.basename(path.dirname(skillFilePath))),
  );
}

/**
 * Links requested repo-local skills into `targetSkillsDirectoryPath`, pruning broken symlinks first.
 *
 * @remarks
 * I/O: Reads `skills/` and target dir; creates directory symlinks. Throws when requested skills are missing.
 *
 * Logging: per-skill output is gated behind SYNC_VERBOSE / WORKFLOWS_SYNC_VERBOSE. State-change
 * lines (newly linked, refreshed, removed stale) and WARN/ERROR always emit. The `targetLabel`
 * option is used in the summary line so a reader can grep one line per registrar.
 *
 * @example
 * const summary = await registerSkillsToTarget({
 *   repositoryRootDirectoryPath: process.cwd(),
 *   requestedSkillNames: [],
 *   targetSkillsDirectoryPath: "./.kimi/skills",
 * });
 * // => { foundCount: 12, linkedCount: 12, addedCount: 0, refreshedCount: 0, ... }
 */
export async function registerSkillsToTarget(
  options: RegisterSkillsToTargetOptions & { targetLabel?: string },
): Promise<RegistrationSummary> {
  const projectSkillsDirectoryPath = path.join(
    options.repositoryRootDirectoryPath,
    "skills",
  );
  const targetLabel =
    options.targetLabel ??
    path.relative(
      options.repositoryRootDirectoryPath,
      options.targetSkillsDirectoryPath,
    );

  if (!(await projectSkillsDirectoryExists({ projectSkillsDirectoryPath }))) {
    console.warn(
      `[skills:sync:${targetLabel}] WARN No project skills directory found at ${projectSkillsDirectoryPath}`,
    );
    return {
      foundCount: 0,
      linkedCount: 0,
      addedCount: 0,
      refreshedCount: 0,
      unchangedCount: 0,
      removedStaleLinksCount: 0,
      skippedCount: 0,
    };
  }

  await fs.mkdir(options.targetSkillsDirectoryPath, { recursive: true });

  const removedStaleLinksCount = await pruneBrokenSkillLinks({
    repositoryRootDirectoryPath: options.repositoryRootDirectoryPath,
    targetSkillsDirectoryPath: options.targetSkillsDirectoryPath,
  });

  let skillFilePaths = await collectSkillFilePaths({
    repositoryRootDirectoryPath: options.repositoryRootDirectoryPath,
  });

  skillFilePaths.sort((firstPath, secondPath) =>
    firstPath.localeCompare(secondPath),
  );
  skillFilePaths = filterSkillFilePaths({
    requestedSkillNames: options.requestedSkillNames,
    skillFilePaths,
  });

  if (skillFilePaths.length === 0) {
    console.warn(
      `[skills:sync:${targetLabel}] WARN No SKILL.md files found under ${projectSkillsDirectoryPath}`,
    );
    return {
      foundCount: 0,
      linkedCount: 0,
      addedCount: 0,
      refreshedCount: 0,
      unchangedCount: 0,
      removedStaleLinksCount,
      skippedCount: 0,
    };
  }

  let addedCount = 0;
  let refreshedCount = 0;
  let unchangedCount = 0;
  let skippedCount = 0;

  for (const skillFilePath of skillFilePaths) {
    const result = await createSkillLink({
      skillFilePath,
      targetSkillsDirectoryPath: options.targetSkillsDirectoryPath,
    });

    if (result === "created") {
      addedCount += 1;
    } else if (result === "refreshed") {
      refreshedCount += 1;
    } else if (result === "unchanged") {
      unchangedCount += 1;
    } else {
      skippedCount += 1;
    }
  }

  const linkedCount = addedCount + refreshedCount + unchangedCount;
  const totalChanges = addedCount + refreshedCount + removedStaleLinksCount;

  if (totalChanges === 0 && skippedCount === 0) {
    console.log(
      `[skills:sync:${targetLabel}] no changes (${skillFilePaths.length} skills already linked)`,
    );
  } else {
    console.log(
      `[skills:sync:${targetLabel}] linked: ${linkedCount} (added: ${addedCount}, refreshed: ${refreshedCount}), skipped: ${skippedCount}, removed stale: ${removedStaleLinksCount}`,
    );
  }

  return {
    foundCount: skillFilePaths.length,
    linkedCount,
    addedCount,
    refreshedCount,
    unchangedCount,
    removedStaleLinksCount,
    skippedCount,
  };
}
