#!/usr/bin/env -S npx tsx
/**
 * @fileoverview Collects repo-local skill metadata and rewrites `SKILLS.<partition>.md` files so lazy-reference indexes stay aligned with canonical skill folders containing `SKILL.md`.
 *
 * @testing CLI: `npm run skills:sync` after adding, renaming, or retargeting skills.
 * @see skills/ide-sync/scripts/skill-index/skill-index-shared.ts - Entry collection, sorting, and markdown render contract shared with other tooling.
 * @documentation reviewed=2026-05-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import path from "node:path";
import {
  collectSkillIndexEntries,
  getGeneratedSkillIndexFiles,
  renderGeneratedSkillIndexFile,
} from "./skill-index-shared";

/**
 * Persists rendered index markdown when the target file is missing or its bytes differ.
 *
 * @remarks
 * I/O: Synchronous `fs` read/write on `options.filePath` (expected absolute). The returned status
 * lets callers emit concise logs without re-stating filesystem state.
 */
function writeGeneratedFile(options: {
  content: string;
  filePath: string;
}): "created" | "unchanged" | "updated" {
  if (!fs.existsSync(options.filePath)) {
    fs.writeFileSync(options.filePath, options.content, "utf8");
    return "created";
  }

  const currentContent = fs.readFileSync(options.filePath, "utf8");
  if (currentContent === options.content) {
    return "unchanged";
  }

  fs.writeFileSync(options.filePath, options.content, "utf8");
  return "updated";
}

/**
 * Runs the skill-index generator from the current working directory as the repository root.
 *
 * @remarks
 * Honors `SYNC_VERBOSE` / `WORKFLOWS_SYNC_VERBOSE` for optional per-file console output. Delegates
 * entry discovery, sorting, and markdown rendering to `./skill-index-shared`.
 */
function main(): void {
  const verbose =
    process.env.SYNC_VERBOSE === "1" ||
    process.env.WORKFLOWS_SYNC_VERBOSE === "1";
  const repoRoot = process.cwd();
  const entries = collectSkillIndexEntries(repoRoot);
  const generatedFiles = getGeneratedSkillIndexFiles(entries);

  for (const generatedFile of generatedFiles) {
    const absoluteFilePath = path.join(repoRoot, generatedFile.relativeFilePath);
    const content = renderGeneratedSkillIndexFile({
      entries,
      partition: generatedFile.partition,
    });
    const status = writeGeneratedFile({
      content,
      filePath: absoluteFilePath,
    });
    const partitionEntryCount = entries.filter((entry) => entry.partition === generatedFile.partition).length;
    if (status === "unchanged") {
      if (verbose) {
        console.log(
          `[skills:sync:indexes] ${generatedFile.relativeFilePath} ✓ (up to date, ${partitionEntryCount} entries)`,
        );
      }
      continue;
    }
    const verb = status === "created" ? "Wrote" : "Updated";
    console.log(
      `[skills:sync:indexes] ${verb} ${generatedFile.relativeFilePath} (${partitionEntryCount} entries)`,
    );
  }
}

main();
