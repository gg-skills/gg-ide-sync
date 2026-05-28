/**
 * @fileoverview Shared skill-index helpers for scanning each immediate child folder under
 * `skills/` for a root `SKILL.md`, reading YAML frontmatter, deriving partition/section
 * labels from folder names, and rendering per-partition `SKILLS.<partition>.md` markdown consumed by
 * ide-sync tooling.
 *
 * Synchronous filesystem reads enumerate immediate child directories, ignore dot-prefixed names,
 * and return sorted entries so generated indexes stay deterministic across hosts.
 *
 * @example
 * ```typescript
 * import {
 *   collectSkillIndexEntries,
 *   getGeneratedSkillIndexFiles,
 *   renderGeneratedSkillIndexFile,
 * } from "./skill-index-shared";
 *
 * const entries = collectSkillIndexEntries(repoRoot);
 * const targets = getGeneratedSkillIndexFiles(entries);
 * const markdown = renderGeneratedSkillIndexFile({
 *   entries,
 *   partition: targets[0]?.partition ?? "general",
 * });
 * ```
 *
 * @testing ESLint (repository root): npm run lint:root-repo-only
 * @testing File-overview gate (repository root): npm run check:typescript-file-overview-errors
 * @see skills/ide-sync/scripts/skill-index/generate-skill-indexes.ts - tsx entry that writes `SKILLS.<partition>.md` using these exports during skills sync.
 * @documentation reviewed=2026-05-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

/**
 * One canonical skill row used when grouping and rendering partition indexes.
 *
 * @remarks
 * `partition` and `section` are derived from the `skills/<name>/` folder name; callers
 * treat `name` as the stable skill identifier matching the on-disk folder.
 */
export type SkillIndexEntry = {
  description: string;
  name: string;
  partition: string;
  section: string;
};

/**
 * Describes a generated markdown file path keyed by partition namespace.
 */
export type GeneratedSkillIndexFile = {
  partition: string;
  relativeFilePath: string;
};

/**
 * Narrow object shape accepted after parsing YAML frontmatter fragments.
 */
type YamlMapping = Record<string, unknown>;

/**
 * Narrows unknown `yaml.load` output to a plain object map suitable for field reads.
 */
function isRecord(value: unknown): value is YamlMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the first YAML frontmatter block from a `SKILL.md` file, if present and parseable.
 *
 * @remarks
 * I/O: Synchronous read of `skillFilePath`. Returns `null` when delimiters are missing, the body is
 * empty, or `yaml.load` yields a non-object (arrays and scalars are rejected).
 */
function readSkillFrontmatter(skillFilePath: string): YamlMapping | null {
  const content = fs.readFileSync(skillFilePath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match || typeof match[1] !== "string") {
    return null;
  }
  const parsed = yaml.load(match[1]);
  return isRecord(parsed) ? parsed : null;
}

/**
 * Converts hyphen-delimited tokens into a title-cased label for markdown headings.
 */
function titleCaseToken(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
    .join(" ");
}

/**
 * Maps a skill folder name to `{ partition, section }` using `skill-`, `skills-`, and default
 * heuristics.
 *
 * @remarks
 * `skills-*` folders map to the suffix namespace with section `Managers`. `skill-*` folders split
 * the remainder on `-` for namespace and optional section token (title-cased). Other names use the
 * first hyphen segment as partition with section `General`.
 */
function resolvePartitionAndSection(skillName: string): { partition: string; section: string } {
  if (skillName.startsWith("skills-")) {
    const namespace = skillName.slice("skills-".length) || "general";
    return { partition: namespace, section: "Managers" };
  }

  if (skillName.startsWith("skill-")) {
    const tokens = skillName.slice("skill-".length).split("-").filter(Boolean);
    const namespace = tokens[0] ?? "general";
    const sectionToken = tokens[1] ?? "general";
    return { partition: namespace, section: titleCaseToken(sectionToken) };
  }

  const firstToken = skillName.split("-").filter(Boolean)[0] ?? "general";
  return { partition: firstToken, section: "General" };
}

/**
 * Collects sorted skill index rows by listing `repoRoot/skills/` child folders and reading
 * each folder's root `SKILL.md`.
 *
 * @remarks
 * I/O: Synchronous directory listing and per-skill file reads under `skills`. Returns an
 * empty array when the skills root is missing.
 */
export function collectSkillIndexEntries(repoRoot: string): SkillIndexEntry[] {
  const skillsRoot = path.join(repoRoot, "skills");
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }

  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap((entry): SkillIndexEntry[] => {
      const skillFilePath = path.join(skillsRoot, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFilePath)) {
        return [];
      }
      const frontmatter = readSkillFrontmatter(skillFilePath);
      const description = typeof frontmatter?.description === "string"
        ? frontmatter.description.trim()
        : "No description provided.";
      const { partition, section } = resolvePartitionAndSection(entry.name);
      return [{ description, name: entry.name, partition, section }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Builds the distinct generated markdown filenames (`SKILLS.<partition>.md`) for all partitions
 * present in `entries`.
 */
export function getGeneratedSkillIndexFiles(entries: SkillIndexEntry[]): GeneratedSkillIndexFile[] {
  return Array.from(new Set(entries.map((entry) => entry.partition)))
    .sort((left, right) => left.localeCompare(right))
    .map((partition) => ({ partition, relativeFilePath: `SKILLS.${partition}.md` }));
}

/**
 * Renders markdown for one partition, grouping bullet lines under sorted section headings.
 *
 * @remarks
 * Pure string assembly; callers persist bytes. Filters `options.entries` to `options.partition`
 * only and emits a trailing newline.
 */
export function renderGeneratedSkillIndexFile(options: {
  entries: SkillIndexEntry[];
  partition: string;
}): string {
  const entries = options.entries.filter((entry) => entry.partition === options.partition);
  const lines = [
    `# ${titleCaseToken(options.partition)} Skills Index`,
    "",
    "Generated from `skills/*/SKILL.md`. Do not edit manually.",
    "",
  ];

  const sections = Array.from(new Set(entries.map((entry) => entry.section))).sort((left, right) => left.localeCompare(right));
  for (const section of sections) {
    lines.push(`## ${section}`, "");
    for (const entry of entries.filter((candidate) => candidate.section === section)) {
      lines.push(`- \`${entry.name}\` — ${entry.description}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
