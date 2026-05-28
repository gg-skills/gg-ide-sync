/**
 * @fileoverview Shared workflow target synchronization helper. Owns multi-target
 * projection of canonical commands into Windsurf, OpenCode, Claude Code, Antigravity
 * Agent, Codex CLI, and Kimi skill surface formats.
 *
 * Flow: discover commands -> normalize body -> apply per-target formatter -> sync output.
 *
 * @example
 * ```typescript
 * import { syncCommandsToTargets, buildDefaultTargetConfigs } from "./targets";
 *
 * const result = syncCommandsToTargets({
 *   commands: [
 *     { name: "wf-test", description: "Test workflow", source: "workflow", workflowContent: "# Test" },
 *   ],
 *   targets: buildDefaultTargetConfigs(),
 *   clearStrategy: "prefixes",
 *   clearPrefixes: ["wf-"],
 *   log: console.log,
 * });
 * ```
 *
 * @testing CLI: npx tsx scripts/canonical-workflows/sync-npm.ts
 * @testing Jest unit: npx jest --config jest.config.ts scripts/__tests__/workflows-targets.unit.test.ts
 *
 * @see scripts/canonical-workflows/sync-skills.ts - Skill workflow entrypoint that calls syncCommandsToTargets.
 * @see scripts/canonical-workflows/sync-npm.ts - NPM workflow entrypoint that calls syncCommandsToTargets.
 * @see scripts/canonical-workflows/sync-ide.ts - IDE workflow entrypoint that calls syncCommandsToTargets and enforces the `wf-` source-file prefix invariant exposed here.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PlatformSubmoduleAutomation_buildDiscoveryWorkflowPrefixes } from "../platform/lib/submodule-automation";

/**
 * When set to "1", emits per-file `Created …` and `Created directory: …` log
 * lines from the writer helpers below. When unset (default), only per-target
 * summary counts and warnings/errors fire — keeping a full `npm run sync`
 * output to roughly the headline summary lines instead of thousands of
 * per-file confirmations.
 */
const VERBOSE_WRITES =
  process.env.SYNC_VERBOSE === "1" ||
  process.env.WORKFLOWS_SYNC_VERBOSE === "1";

/** Prefix used when projecting an npm script into a command/workflow folder. The leading `run-` verb mirrors the run-skill-* convention; signals the entry is a runnable npm command. */
export const NPM_WORKFLOW_PREFIX = "run-npm-";
/** Canonical name prefix for canonical skills (matches the on-disk `skills/skill-*` naming). Used unchanged for the Kimi skill folder name. */
export const SKILL_WORKFLOW_PREFIX = "skill-";
/** Canonical name prefix for skill-index aggregator skills (matches the on-disk `skills/skills-*` naming). Used unchanged for the Kimi skill folder name. */
export const SKILLS_MANAGER_WORKFLOW_PREFIX = "skills-";
/** Prefix used when projecting a canonical skill into a command/workflow folder (OpenCode, Claude Code, Codex, Windsurf, Antigravity). The leading `run-` verb signals the entry is a runnable command that loads the underlying canonical skill. */
export const RUN_SKILL_WORKFLOW_PREFIX = "run-skill-";
/** Prefix used when projecting a canonical skill-index aggregator skill into a command/workflow folder. */
export const RUN_SKILLS_MANAGER_WORKFLOW_PREFIX = "run-skills-";
/**
 * Mandatory prefix on every canonical workflow source file and projected command.
 *
 * @remarks
 * Source contract: every file under `canonical-workflows/` MUST be named
 * `wf-<slug>.md`. The projected command name is derived verbatim from the
 * filename, so this prefix flows through to every IDE/skill target written by
 * `syncCommandsToTargets`.
 *
 * USAGE: read by `sync-ide.ts` for soft-warning detection of mis-named source
 * files; enforced at write time by `assertCanonicalWorkflowProjectionName`.
 * The prefix also serves as a safe identifier for stale-projection cleanup in
 * target directories.
 *
 * Token taxonomy: `wf-` disambiguates canonical-workflow projections from
 * `run-npm-*` (npm scripts), `run-skill-*` (canonical skills), and
 * `run-skills-*` (canonical skill-index aggregators) inside every IDE
 * command/workflow folder.
 *
 * INVARIANT: this constant is deliberately NOT included in
 * `STATIC_GENERATED_WORKFLOW_PREFIXES`. Canonical workflow files are the
 * manual source of truth, not generated output, and including the prefix
 * there would cause `clearManualMarkdownFiles` to skip them.
 *
 * @see {@link STATIC_GENERATED_WORKFLOW_PREFIXES} - Generated-prefix list this constant is intentionally excluded from.
 */
export const CANONICAL_WORKFLOW_PROJECTION_PREFIX = "wf-";
/** Statically known generated workflow name prefixes that this module owns. */
export const STATIC_GENERATED_WORKFLOW_PREFIXES = [
  NPM_WORKFLOW_PREFIX,
  SKILL_WORKFLOW_PREFIX,
  SKILLS_MANAGER_WORKFLOW_PREFIX,
  RUN_SKILL_WORKFLOW_PREFIX,
  RUN_SKILLS_MANAGER_WORKFLOW_PREFIX,
];
/** All generated workflow name prefixes that this module owns in the current checkout. */
export const GENERATED_WORKFLOW_PREFIXES = Array.from(
  new Set([
    ...STATIC_GENERATED_WORKFLOW_PREFIXES,
    ...PlatformSubmoduleAutomation_buildDiscoveryWorkflowPrefixes({
      rootDir: process.cwd(),
    }),
  ]),
);

/**
 * Marker that signals where user-provided context will be appended at runtime.
 * All target formatters must preserve this as the very last heading in the output.
 */
export const ADDITIONAL_USER_CONTEXT_MARKER =
  "\n\n# Additional user context (if any)\n```\n$ARGUMENTS\n```\n\n";

/**
 * Builds the markdown "## Command Details" appendix injected before the user-context marker.
 *
 * @remarks
 * PURITY: String-only; callers merge this into formatted workflow bodies per target.
 */
export function buildCommandDetailsSection(command: Command): string {
  return `\n## Command Details\n\n**Type:** ${command.source}\n**Name:** ${command.name}\n`;
}

/**
 * Normalizes a workflow body so it ends with the canonical trailing
 * "
# Additional user context (if any)
```
$ARGUMENTS
```" marker.
 */
export function ensureAdditionalUserContextMarker(body: string): string {
  const normalizedBody = body.replace(/\r\n/g, "\n").trimEnd();
  const trailingMarkerPattern = /\n#{1,2} Additional user context\n*$/;
  const withoutTrailingMarker = normalizedBody.replace(trailingMarkerPattern, "");
  return withoutTrailingMarker + ADDITIONAL_USER_CONTEXT_MARKER;
}

/**
 * Inserts target-specific content before the trailing "
# Additional user context (if any)
```
$ARGUMENTS
```"
 * marker, ensuring the marker is always the last heading in the output.
 */
export function insertBeforeUserContext(body: string, extraContent: string): string {
  const normalizedBody = ensureAdditionalUserContextMarker(body);
  return (
    normalizedBody.slice(0, -ADDITIONAL_USER_CONTEXT_MARKER.length) +
    extraContent +
    ADDITIONAL_USER_CONTEXT_MARKER
  );
}

/** Default Windsurf workflows output directory, relative to repo root. */
export const WINDSURF_WORKFLOWS_DIR = ".windsurf/workflows";
/** Default OpenCode commands output directory, relative to repo root. */
export const OPENCODE_COMMANDS_DIR = ".opencode/command";
/** Default Claude Code commands output directory, relative to repo root. */
export const CLAUDECODE_COMMANDS_DIR = ".claude/commands";
/** Default Antigravity Agent workflows output directory, relative to repo root. */
export const AGENTS_WORKFLOWS_DIR = ".agents/workflows";
/** Codex prompts directory; falls back to ~/.codex/prompts when CODEX_PROMPTS_DIR is unset. */
export const CODEX_PROMPTS_DIR =
  process.env.CODEX_PROMPTS_DIR || path.join(os.homedir(), ".codex", "prompts");
/** Default Kimi skills output directory, relative to repo root. */
export const KIMI_SKILLS_DIR = ".kimi/skills";

/** Enumerates the supported target format dialects for workflow output. */
export type TargetConfigFormat = "opencode" | "claudecode" | "codex" | "mirror" | "kimi";

/** Describes a single target output surface (tool, format, and directory). */
export type TargetConfig = {
  name: string;
  format: TargetConfigFormat;
  directory: string;
};

/** Canonical workflow command row loaded from markdown before formatting for each IDE target. */
export type Command = {
  name: string;
  description: string;
  source: string;
  workflowContent: string;
  command?: string;
  /**
   * When set, the Kimi target writes this body verbatim with `type: skill` in the
   * frontmatter (representing a canonical skill, not a flow). When omitted, the Kimi
   * target falls back to projecting `workflowContent` as `type: flow`.
   */
  kimiSkillBody?: string;
  /**
   * When set, the Kimi target uses this name as the per-skill folder name under
   * `.kimi/skills/`, instead of the default `command.name`. This lets the
   * command/workflow targets (OpenCode, Claude Code, Codex, Windsurf, Antigravity)
   * use a `run-skill-*` projection name while the Kimi target keeps the canonical
   * `skill-*` folder name. Only meaningful when `kimiSkillBody` is also set.
   */
  kimiSkillFolder?: string;
};

/** Structured logger compatible with the sync result reporting surface. */
export type LogFn = (message: string, type?: "info" | "warn" | "error") => void;

/** Options passed to syncCommandsToTargets. */
export type SyncCommandsToTargetsOptions = {
  commands: Command[];
  targets: TargetConfig[];
  dryRun?: boolean;
  clearStrategy: "prefixes" | "manual";
  clearPrefixes?: string[];
  log: LogFn;
};

/** Aggregated sync result counts across all targets. */
export type SyncCommandsToTargetsResult = {
  successTargets: number;
  failedTargets: number;
};

/**
 * Builds the default multi-target workflow destinations for this checkout (Windsurf, OpenCode, etc.).
 *
 * @remarks
 * PURITY: No writes. Uses `process.cwd()` when `repoRoot` is omitted.
 */
export function buildDefaultTargetConfigs(repoRoot = process.cwd()): TargetConfig[] {
  return [
    {
      name: "Windsurf",
      format: "mirror",
      directory: path.join(repoRoot, WINDSURF_WORKFLOWS_DIR),
    },
    {
      name: "OpenCode",
      format: "opencode",
      directory: path.join(repoRoot, OPENCODE_COMMANDS_DIR),
    },
    {
      name: "Claude Code",
      format: "claudecode",
      directory: path.join(repoRoot, CLAUDECODE_COMMANDS_DIR),
    },
    {
      name: "Antigravity Agent",
      format: "mirror",
      directory: path.join(repoRoot, AGENTS_WORKFLOWS_DIR),
    },
    {
      name: "Codex CLI",
      format: "codex",
      directory: CODEX_PROMPTS_DIR,
    },
    {
      name: "Kimi",
      format: "kimi",
      directory: path.join(repoRoot, KIMI_SKILLS_DIR),
    },
  ];
}

/**
 * Collapses internal whitespace so descriptions stay stable in YAML and IDE metadata.
 *
 * @remarks
 * PURITY: Normalizes only the input string; does not trim semantic leading/trailing intent beyond `trim`.
 */
export function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

/**
 * Strips `// turbo` auto-execution markers from workflow body content.
 * These markers are a Windsurf Cascade convention and are meaningless noise
 * for targets that do not support them (Claude Code, OpenCode, Codex, Kimi).
 * Mirror-format targets (Windsurf, Antigravity) should NOT call this.
 */
export function stripTurboMarkers(body: string): string {
  return body.replace(/^[ \t]*\/\/ turbo[ \t]*\r?\n/gm, "");
}

/** Quotes and escapes a string for safe inclusion in a YAML scalar value. */
export function toYamlQuotedString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ").trim()}"`;
}

/**
 * Ensures a directory exists before writes, creating parents recursively when missing.
 *
 * @remarks
 * I/O: Sync `fs.mkdirSync` when absent. When `VERBOSE_WRITES` is enabled, logs directory creation.
 */
function ensureDirectoryExists(directory: string, log: LogFn): void {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
    if (VERBOSE_WRITES) {
      log(`Created directory: ${directory}`);
    }
  }
}

/**
 * Lists `.md` filenames in a directory, skipping `.gitkeep` placeholders.
 *
 * @remarks
 * I/O: Sync `fs.readdirSync`; returns empty array when the directory is missing.
 */
function getMarkdownFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory).filter((file) => file.endsWith(".md") && file !== ".gitkeep");
}

/**
 * Describes a single write attempt's effect on disk.
 *
 * - `created`: the target file did not exist; we wrote it.
 * - `updated`: the target file existed but content differed; we overwrote it.
 * - `unchanged`: the file existed with byte-identical content; no write performed.
 * - `error`: the write threw (already logged).
 */
export type WriteOutcome = "created" | "updated" | "unchanged" | "error";

/**
 * Writes `content` to `filePath` only if the on-disk bytes differ.
 * Returns the diff outcome so callers can tally diff-aware stats.
 */
function writeIfChanged(filePath: string, content: string): WriteOutcome {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing === content) {
      return "unchanged";
    }
    fs.writeFileSync(filePath, content, "utf8");
    return "updated";
  }
  fs.writeFileSync(filePath, content, "utf8");
  return "created";
}

/**
 * Deletes markdown files whose names start with any of the given prefixes.
 *
 * @remarks
 * I/O: Removes matching `.md` files only; logs a single summary when anything was deleted.
 * USAGE: Used for stale cleanup before regenerating a target lane.
 */
export function clearPrefixedMarkdownFiles(
  directory: string,
  prefixes: string[],
  log: LogFn,
): number {
  const files = getMarkdownFiles(directory).filter((file) =>
    prefixes.some((prefix) => file.startsWith(prefix)),
  );

  let deletedCount = 0;
  for (const file of files) {
    fs.rmSync(path.join(directory, file), { force: true });
    deletedCount += 1;
  }

  if (deletedCount > 0) {
    log(
      `Cleared ${deletedCount} generated workflow files from ${directory} (${prefixes.join(", ")})`,
    );
  }

  return deletedCount;
}

/** Removes all non-generated markdown files from directory (files not starting with any GENERATED_WORKFLOW_PREFIX). Returns count deleted. */
export function clearManualMarkdownFiles(directory: string, log: LogFn): number {
  const files = getMarkdownFiles(directory).filter(
    (file) => !GENERATED_WORKFLOW_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );

  let deletedCount = 0;
  for (const file of files) {
    fs.rmSync(path.join(directory, file), { force: true });
    deletedCount += 1;
  }

  if (deletedCount > 0) {
    log(`Cleared ${deletedCount} manual workflow files from ${directory}`);
  }

  return deletedCount;
}

/**
 * Writes an OpenCode command markdown file with YAML frontmatter and injected command details.
 *
 * @remarks
 * I/O: Ensures `commandDir`, strips leading YAML frontmatter from source content, strips turbo
 * markers, then writes only when bytes differ. Logs errors and returns `"error"` on failure.
 */
export function createOpenCodeCommandFile(
  commandDir: string,
  command: Command,
  log: LogFn,
): WriteOutcome {
  try {
    ensureDirectoryExists(commandDir, log);

    const fileName = `${command.name}.md`;
    const filePath = path.join(commandDir, fileName);
    const cleanDescription = normalizeDescription(command.description)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    const workflowContent = command.workflowContent || (command.command ?? "");
    const cleanWorkflowContent = stripTurboMarkers(
      workflowContent.replace(/^---[\s\S]*?---(?:\r?\n|$)/, ""),
    );
    const detailsSection = buildCommandDetailsSection(command);
    const body = insertBeforeUserContext(cleanWorkflowContent, detailsSection);

    const content = `---
name: ${command.name}
description: "${cleanDescription}"
---

${body}`;

    const outcome = writeIfChanged(filePath, content);
    if (VERBOSE_WRITES && outcome !== "unchanged") {
      log(`${outcome === "created" ? "Created" : "Updated"} OpenCode command file: ${fileName}`);
    }
    return outcome;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Error creating OpenCode command file ${command.name}: ${msg}`, "error");
    return "error";
  }
}

/**
 * Writes a Claude Code command markdown file with quoted YAML description and injected details.
 *
 * @remarks
 * I/O: Ensures `commandDir`, strips turbo markers and outer frontmatter from workflow content,
 * then diff-aware write. Logs errors and returns `"error"` on failure.
 */
export function createClaudeCodeCommandFile(
  commandDir: string,
  command: Command,
  log: LogFn,
): WriteOutcome {
  try {
    ensureDirectoryExists(commandDir, log);

    const fileName = `${command.name}.md`;
    const filePath = path.join(commandDir, fileName);
    const workflowContent = command.workflowContent || (command.command ?? "");
    const cleanWorkflowContent = stripTurboMarkers(
      workflowContent.replace(/^---[\s\S]*?---(?:\r?\n|$)/, ""),
    );
    const detailsSection = buildCommandDetailsSection(command);
    const body = insertBeforeUserContext(cleanWorkflowContent, detailsSection);

    const content = `---
description: ${toYamlQuotedString(normalizeDescription(command.description))}
---

${body}`;

    const outcome = writeIfChanged(filePath, content);
    if (VERBOSE_WRITES && outcome !== "unchanged") {
      log(`${outcome === "created" ? "Created" : "Updated"} Claude Code command file: ${fileName}`);
    }
    return outcome;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Error creating Claude Code command file ${command.name}: ${msg}`, "error");
    return "error";
  }
}

/**
 * Default auto_execution_mode for mirror-format targets when not explicitly set.
 * Mode 1 = automatic execution (broadest permissions).
 */
export const DEFAULT_MIRROR_AUTO_EXECUTION_MODE = 1;

/**
 * Ensures mirror-format output contains `auto_execution_mode` in its YAML frontmatter.
 * When the source already specifies the field it is preserved as-is; otherwise the
 * default (mode 1 – broadest permissions) is injected.
 */
export function ensureMirrorAutoExecutionMode(body: string, command: Command): string {
  const frontmatterMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!frontmatterMatch) {
    return `---
description: ${toYamlQuotedString(normalizeDescription(command.description))}
auto_execution_mode: ${DEFAULT_MIRROR_AUTO_EXECUTION_MODE}
---

${body}
`;
  }

  const frontmatterBlock = frontmatterMatch[1];

  if (/^auto_execution_mode:/m.test(frontmatterBlock)) {
    return body;
  }

  const rest = body.slice(frontmatterMatch[0].length);
  return `---\n${frontmatterBlock}\nauto_execution_mode: ${DEFAULT_MIRROR_AUTO_EXECUTION_MODE}\n---\n${rest}`;
}

/**
 * Writes mirror-format workflow markdown (Windsurf / Antigravity) preserving turbo markers.
 *
 * @remarks
 * I/O: Ensures `commandDir`, appends command details, injects `auto_execution_mode` when absent via
 * {@link ensureMirrorAutoExecutionMode}, then diff-aware write.
 */
export function createWorkflowMirrorFile(
  commandDir: string,
  command: Command,
  targetName: string,
  log: LogFn,
): WriteOutcome {
  try {
    ensureDirectoryExists(commandDir, log);

    const fileName = `${command.name}.md`;
    const filePath = path.join(commandDir, fileName);
    const workflowContent = command.workflowContent || (command.command ?? "");
    const detailsSection = buildCommandDetailsSection(command);
    const bodyWithDetails = insertBeforeUserContext(workflowContent, detailsSection);
    const content = ensureMirrorAutoExecutionMode(bodyWithDetails, command);

    const outcome = writeIfChanged(filePath, content);
    if (VERBOSE_WRITES && outcome !== "unchanged") {
      log(`${outcome === "created" ? "Created" : "Updated"} ${targetName} workflow file: ${fileName}`);
    }
    return outcome;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Error creating ${targetName} workflow file ${command.name}: ${msg}`, "error");
    return "error";
  }
}

/**
 * Writes a Codex CLI prompt markdown file without YAML frontmatter wrapping.
 *
 * @remarks
 * I/O: Ensures `commandDir`, strips turbo markers and outer frontmatter, injects command details
 * ahead of the user-context marker, then diff-aware write.
 */
export function createCodexPromptFile(
  commandDir: string,
  command: Command,
  log: LogFn,
): WriteOutcome {
  try {
    ensureDirectoryExists(commandDir, log);

    const fileName = `${command.name}.md`;
    const filePath = path.join(commandDir, fileName);
    const workflowContent = command.workflowContent || (command.command ?? "");
    const cleanWorkflowContent = stripTurboMarkers(
      workflowContent.replace(/^---[\s\S]*?---(?:\r?\n|$)/, ""),
    );
    const detailsSection = buildCommandDetailsSection(command);
    const content = insertBeforeUserContext(cleanWorkflowContent, detailsSection);

    const outcome = writeIfChanged(filePath, content);
    if (VERBOSE_WRITES && outcome !== "unchanged") {
      log(`${outcome === "created" ? "Created" : "Updated"} Codex prompt file: ${fileName}`);
    }
    return outcome;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Error creating Codex prompt file ${command.name}: ${msg}`, "error");
    return "error";
  }
}

/**
 * Writes a Kimi entry directory with SKILL.md to skillsDir/command.name/.
 *
 * @remarks
 * Discrimination: when `command.kimiSkillBody` is present, the body is treated as a
 * canonical skill and the frontmatter `type` is set to `skill` (preserving the
 * existing canonical SKILL.md frontmatter and prose verbatim). Otherwise the entry is
 * projected as a flow (the historical behavior, used for canonical-workflows and
 * package.json scripts).
 */
export function createKimiSkillFile(
  skillsDir: string,
  command: Command,
  log: LogFn,
): WriteOutcome {
  try {
    if (command.kimiSkillBody) {
      // Canonical skill projection: write the canonical SKILL.md verbatim with
      // `type: skill` injected into its existing frontmatter. Use the
      // canonical `skill-*` folder name (kimiSkillFolder) instead of the
      // command/workflow `run-skill-*` name (command.name) so Kimi sees the
      // skill at its canonical path.
      const folderName = command.kimiSkillFolder ?? command.name;
      const folderPath = path.join(skillsDir, folderName);
      ensureDirectoryExists(folderPath, log);
      const skillFilePath = path.join(folderPath, "SKILL.md");
      const content = injectKimiTypeIntoFrontmatter(
        command.kimiSkillBody,
        "skill",
      );
      const outcome = writeIfChanged(skillFilePath, content);
      if (VERBOSE_WRITES && outcome !== "unchanged") {
        log(
          `${outcome === "created" ? "Created" : "Updated"} Kimi skill file (type=skill): ${folderName}/SKILL.md`,
        );
      }
      return outcome;
    }

    const skillDir = path.join(skillsDir, command.name);
    ensureDirectoryExists(skillDir, log);
    const filePath = path.join(skillDir, "SKILL.md");
    const workflowContent = command.workflowContent || (command.command ?? "");

    // Parse existing frontmatter
    const frontmatterMatch = workflowContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    let body = workflowContent;
    let existingDescription = normalizeDescription(command.description);

    if (frontmatterMatch && typeof frontmatterMatch[1] === "string") {
      body = workflowContent.slice(frontmatterMatch[0].length);

      // Extract description from existing frontmatter if present
      const descMatch = frontmatterMatch[1].match(/^description:\s*"?([^"\n]+)"?/m);
      if (descMatch) {
        existingDescription = normalizeDescription(descMatch[1]);
      }
    }

    body = stripTurboMarkers(body);

    const frontmatter = [
      "---",
      `name: ${command.name}`,
      `description: ${toYamlQuotedString(existingDescription)}`,
      "type: flow",
      "---",
    ].join("\n");

    const detailsSection = buildCommandDetailsSection(command);
    const bodyWithDetails = insertBeforeUserContext(body, detailsSection);
    const content = `${frontmatter}\n\n${bodyWithDetails}`;

    const outcome = writeIfChanged(filePath, content);
    if (VERBOSE_WRITES && outcome !== "unchanged") {
      log(
        `${outcome === "created" ? "Created" : "Updated"} Kimi skill file (type=flow): ${command.name}/SKILL.md`,
      );
    }
    return outcome;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Error creating Kimi skill file ${command.name}: ${msg}`, "error");
    return "error";
  }
}

/**
 * Inserts or replaces the `type:` field in the YAML frontmatter of a markdown body.
 *
 * - When the body has a frontmatter block: replaces an existing `type:` line or
 *   appends a new one before the closing `---`.
 * - When the body has no frontmatter: prepends a minimal frontmatter block with the
 *   given type. This branch is defensive; canonical SKILL.md always has frontmatter.
 */
function injectKimiTypeIntoFrontmatter(
  body: string,
  kimiType: "skill" | "flow",
): string {
  const frontmatterMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!frontmatterMatch) {
    return `---\ntype: ${kimiType}\n---\n\n${body}`;
  }

  const originalFrontmatter = frontmatterMatch[1];
  const closingMatch = frontmatterMatch[2];
  const restStart = frontmatterMatch[0].length;
  const rest = body.slice(restStart);

  const updatedFrontmatter = /^type:\s/m.test(originalFrontmatter)
    ? originalFrontmatter.replace(/^type:.*$/m, `type: ${kimiType}`)
    : `${originalFrontmatter}\ntype: ${kimiType}`;

  const newline = closingMatch.length > 0 ? closingMatch : "\n";
  return `---\n${updatedFrontmatter}\n---${newline}${rest}`;
}

/**
 * Removes Kimi skill directories under `skillsDir` according to the active clear strategy.
 *
 * @remarks
 * I/O: Recursive `fs.rmSync` on matching directories; logs a summary when any removals occur.
 * `"prefixes"` removes dirs whose names start with a listed prefix; `"manual"` removes dirs that do
 * not match any generated workflow prefix.
 */
export function clearKimiSkillDirectories(
  skillsDir: string,
  clearStrategy: "prefixes" | "manual",
  clearPrefixes: string[],
  log: LogFn,
): number {
  if (!fs.existsSync(skillsDir)) {
    return 0;
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());

  let deletedCount = 0;

  for (const dir of directories) {
    const dirName = dir.name;
    const dirPath = path.join(skillsDir, dirName);

    if (clearStrategy === "prefixes") {
      if (clearPrefixes.some((prefix) => dirName.startsWith(prefix))) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        deletedCount += 1;
      }
    } else if (clearStrategy === "manual") {
      if (!GENERATED_WORKFLOW_PREFIXES.some((prefix) => dirName.startsWith(prefix))) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        deletedCount += 1;
      }
    }
  }

  if (deletedCount > 0) {
    const strategyLabel =
      clearStrategy === "prefixes"
        ? `prefixes (${clearPrefixes.join(", ")})`
        : "manual";
    log(
      `Cleared ${deletedCount} Kimi skill directories from ${skillsDir} [${strategyLabel}]`,
    );
  }

  return deletedCount;
}

/**
 * Returns a human-readable label for the artifacts a target writes (used in dry-run output).
 */
function getTargetLabel(target: TargetConfig): string {
  switch (target.format) {
    case "opencode":
      return "OpenCode command files";
    case "claudecode":
      return "Claude Code command files";
    case "codex":
      return "Codex prompt files";
    case "kimi":
      return "Kimi skill files";
    default:
      return `${target.name} workflow files`;
  }
}

/**
 * Dispatches a single command to the formatter that matches the target's dialect.
 *
 * @remarks
 * Logs and returns `"error"` when the format is not recognized.
 */
function writeCommandToTarget(
  target: TargetConfig,
  command: Command,
  log: LogFn,
): WriteOutcome {
  switch (target.format) {
    case "opencode":
      return createOpenCodeCommandFile(target.directory, command, log);
    case "claudecode":
      return createClaudeCodeCommandFile(target.directory, command, log);
    case "codex":
      return createCodexPromptFile(target.directory, command, log);
    case "kimi":
      return createKimiSkillFile(target.directory, command, log);
    case "mirror":
      return createWorkflowMirrorFile(target.directory, command, target.name, log);
    default:
      log(`Unsupported target format: ${target.format}`, "error");
      return "error";
  }
}

/**
 * Computes the expected on-disk entry name for a single command in a target.
 *
 * Mirror/opencode/claudecode/codex targets project to `<command.name>.md`. Kimi
 * targets project to a directory whose name is the canonical `kimiSkillFolder`
 * when present (canonical skills) or `command.name` otherwise (workflows /
 * generated flows).
 */
function getExpectedEntryName(target: TargetConfig, command: Command): string {
  if (target.format === "kimi") {
    return command.kimiSkillFolder ?? command.name;
  }
  return `${command.name}.md`;
}

/**
 * Removes target-directory entries that are NOT in the expected name set but
 * ARE owned by this sync lane (matched by `clearStrategy` + `clearPrefixes`).
 *
 * Returns the count removed. Used for diff-aware cleanup so a no-op rerun
 * yields `0 removed`. WARN-free fallthrough when the directory does not exist.
 */
function clearStaleTargetEntries(
  target: TargetConfig,
  expectedNames: Set<string>,
  clearStrategy: "prefixes" | "manual",
  clearPrefixes: string[],
): number {
  if (!fs.existsSync(target.directory)) {
    return 0;
  }

  /**
   * Whether an on-disk entry name is owned by this sync lane for stale-entry cleanup.
   *
   * @remarks
   * Under `"prefixes"`, ownership matches `clearPrefixes`; under `"manual"`, ownership is the
   * complement of {@link GENERATED_WORKFLOW_PREFIXES} name prefixes.
   */
  const ownsName = (name: string): boolean => {
    if (clearStrategy === "prefixes") {
      return clearPrefixes.some((prefix) => name.startsWith(prefix));
    }
    // "manual" — owns names that do NOT start with any generated prefix.
    return !GENERATED_WORKFLOW_PREFIXES.some((prefix) => name.startsWith(prefix));
  };

  let removed = 0;

  if (target.format === "kimi") {
    const entries = fs.readdirSync(target.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      if (expectedNames.has(dirName)) continue;
      if (!ownsName(dirName)) continue;
      fs.rmSync(path.join(target.directory, dirName), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  for (const fileName of getMarkdownFiles(target.directory)) {
    if (expectedNames.has(fileName)) continue;
    if (!ownsName(fileName)) continue;
    fs.rmSync(path.join(target.directory, fileName), { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Logs a bounded preview of planned writes for one target without touching the filesystem.
 *
 * @remarks
 * Lists at most five representative paths; mirrors vs Kimi paths choose `.md` vs `SKILL.md` layout.
 */
function showDryRun(target: TargetConfig, commands: Command[], log: LogFn): void {
  const label = getTargetLabel(target);
  const isKimi = target.format === "kimi";
  log(`\n=== DRY RUN: ${target.name} ===`);
  log(`Directory: ${target.directory}`);
  log(`${label} to create: ${commands.length}`);

  commands.slice(0, 5).forEach((command) => {
    const displayPath = isKimi ? `${command.name}/SKILL.md` : `${command.name}.md`;
    log(`  - ${displayPath}`);
  });

  if (commands.length > 5) {
    log(`  ... and ${commands.length - 5} more`);
  }

  log("=== END DRY RUN ===\n");
}

/**
 * Writes normalized workflow markdown for every command into each configured target directory.
 *
 * @remarks
 * I/O: Creates directories, removes ONLY stale entries owned by this lane (no
 * nuke-and-rewrite), writes per-command files only when content differs.
 * Emits one dense diff-aware summary line per target — `<target>: N written
 * (M changed, K removed, E errors)` — so a no-op rerun reports `0 changed`.
 * When `dryRun` is true, logs a preview only and skips filesystem mutations.
 */
export function syncCommandsToTargets(
  options: SyncCommandsToTargetsOptions,
): SyncCommandsToTargetsResult {
  const {
    commands,
    targets,
    dryRun = false,
    clearStrategy,
    clearPrefixes = [],
    log,
  } = options;

  let successTargets = 0;
  let failedTargets = 0;

  for (const target of targets) {
    if (dryRun) {
      showDryRun(target, commands, log);
      successTargets += 1;
      continue;
    }

    ensureDirectoryExists(target.directory, log);

    const expectedNames = new Set<string>(
      commands.map((command) => getExpectedEntryName(target, command)),
    );
    const removed = clearStaleTargetEntries(
      target,
      expectedNames,
      clearStrategy,
      clearPrefixes,
    );

    let createdCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    let errorCount = 0;

    for (const command of commands) {
      const outcome = writeCommandToTarget(target, command, log);
      switch (outcome) {
        case "created":
          createdCount += 1;
          break;
        case "updated":
          updatedCount += 1;
          break;
        case "unchanged":
          unchangedCount += 1;
          break;
        case "error":
          errorCount += 1;
          break;
      }
    }

    const written = createdCount + updatedCount + unchangedCount;
    const changed = createdCount + updatedCount;

    log(
      `${target.name}: ${written} written (${changed} changed, ${removed} removed, ${errorCount} errors)`,
    );

    if (errorCount === 0) {
      successTargets += 1;
    } else {
      failedTargets += 1;
    }
  }

  return {
    successTargets,
    failedTargets,
  };
}
