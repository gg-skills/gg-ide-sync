/**
 * @fileoverview Canonical-workflows skill-sync script. Generates `skill-*` IDE workflow
 * shortcuts from repo-local `skills` folders containing `SKILL.md`.
 *
 * Flow: discover skill folders → parse SKILL frontmatter and optional OpenAI interface blurbs
 * → build `Command[]` → dry-run or write via `syncCommandsToTargets` with skill-prefix clears.
 *
 * @example
 * ```bash
 * # Preview what would be generated (dry-run)
 * npx tsx scripts/canonical-workflows/sync-skills.ts
 *
 * # Apply generated workflow shortcuts to all targets
 * npx tsx scripts/canonical-workflows/sync-skills.ts --write
 * ```
 *
 * @testing CLI manual: run `npx tsx scripts/canonical-workflows/sync-skills.ts [--write]` from the repo root and inspect target output directories.
 * @see scripts/canonical-workflows/targets.ts - Shared target routing helpers and command sync utilities.
 * @see scripts/canonical-agents/generate.ts - Agent guidance generator that may consume synced skill workflows.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs, { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

import {
  buildDefaultTargetConfigs,
  type Command,
  RUN_SKILL_WORKFLOW_PREFIX,
  RUN_SKILLS_MANAGER_WORKFLOW_PREFIX,
  SKILL_WORKFLOW_PREFIX,
  SKILLS_MANAGER_WORKFLOW_PREFIX,
  syncCommandsToTargets,
  toYamlQuotedString,
} from "./targets";

const SKILLS_DIR = "skills";
const SKILL_DEFINITION_FILE = "SKILL.md";
const SKILL_OPENAI_INTERFACE_FILE = path.join("agents", "openai.yaml");
const POSSIBLE_SKILL_LOCATIONS = [
  path.join(process.cwd(), SKILLS_DIR),
];

/**
 * Aggregated metadata for one `skills/<name>` folder used by workflow generation.
 *
 * @remarks
 * `skillFileContent` preserves raw SKILL.md for Kimi `type: skill` projection.
 */
type SkillDefinition = {
  commandDescription: string;
  fullDescription: string;
  skillName: string;
  resolvedSkillName: string;
  relativeSkillPath: string;
  /** Raw SKILL.md file content with original frontmatter; used by the Kimi target to project canonical skills as `type: skill`. */
  skillFileContent: string;
};

/**
 * Verbose toggle. Set `WORKFLOWS_SYNC_VERBOSE=1` (or legacy `SYNC_VERBOSE=1`) to
 * restore setup chatter. Errors and warnings are NEVER gated.
 */
const VERBOSE_LOG =
  process.env.WORKFLOWS_SYNC_VERBOSE === "1" ||
  process.env.SYNC_VERBOSE === "1";

/**
 * Emits a prefixed console line at the chosen severity.
 *
 * @remarks
 * Not gated by `VERBOSE_LOG`; use `vlog` for verbose-only chatter.
 */
function log(message: string, type: "info" | "warn" | "error" = "info"): void {
  const prefix = "[sync-workflows-skills]";

  switch (type) {
    case "info":
      console.log(`${prefix} ${message}`);
      break;
    case "warn":
      console.warn(`${prefix} [WARN] ${message}`);
      break;
    case "error":
      console.error(`${prefix} [ERROR] ${message}`);
      break;
  }
}

/** Verbose-only info log; gated behind WORKFLOWS_SYNC_VERBOSE. */
function vlog(message: string): void {
  if (VERBOSE_LOG) {
    log(message);
  }
}

/**
 * Reports whether a path appears to exist without surfacing filesystem errors as throws.
 *
 * @remarks
 * I/O: synchronous `fs.existsSync`. Unexpected errors log as errors and yield false.
 */
function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Error checking file existence for ${filePath}: ${msg}`, "error");
    return false;
  }
}

/**
 * Returns the first existing directory among candidate roots for a labeled resource.
 *
 * @remarks
 * When no candidate matches, logs every checked path at warn severity.
 */
function findDirectory(
  possibleLocations: string[],
  label: string,
): string | null {
  vlog(`Searching for ${label}...`);

  for (const directoryPath of possibleLocations) {
    if (fileExists(directoryPath)) {
      vlog(`Found ${label} at: ${directoryPath}`);
      return directoryPath;
    }
  }

  log(`Could not find ${label}. Checked locations:`, "warn");
  possibleLocations.forEach((directoryPath) =>
    log(`  - ${directoryPath}`, "warn"),
  );
  return null;
}

/**
 * Resolves the canonical skill name (matches the on-disk `skills/<name>` directory
 * name) for a given skill. This is the name the Kimi target uses for its `.kimi/skills/<name>/`
 * folder.
 */
function buildSkillCanonicalName(skillName: string): string {
  if (
    skillName.startsWith(SKILL_WORKFLOW_PREFIX) ||
    skillName.startsWith(SKILLS_MANAGER_WORKFLOW_PREFIX)
  ) {
    return skillName;
  }

  return `${SKILL_WORKFLOW_PREFIX}${skillName}`;
}

/**
 * Builds the projection name used by command/workflow targets (OpenCode, Claude Code, Codex,
 * Windsurf, Antigravity). Prepends `run-` so the entry reads as a runnable command that loads
 * the underlying canonical skill, e.g. `run-skill-research-online`.
 */
function buildSkillRunCommandName(canonicalName: string): string {
  if (canonicalName.startsWith(RUN_SKILL_WORKFLOW_PREFIX)) {
    return canonicalName;
  }
  if (canonicalName.startsWith(RUN_SKILLS_MANAGER_WORKFLOW_PREFIX)) {
    return canonicalName;
  }
  return `run-${canonicalName}`;
}

/**
 * Parses YAML text into a single plain-object map when the root value is an object record.
 *
 * @remarks
 * Arrays and scalar roots normalize to null. Parse failures log a warning and return null.
 */
function loadYamlObject(rawText: string): Record<string, unknown> | null {
  try {
    const loaded = yaml.load(rawText);
    if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
      return null;
    }
    return loaded as Record<string, unknown>;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Failed to parse YAML content: ${msg}`, "warn");
    return null;
  }
}

/**
 * Reads a string field from parsed YAML data, requiring a non-empty value after trim.
 */
function extractYamlStringValue(
  yamlData: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = yamlData?.[key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

/**
 * Splits YAML frontmatter from the remainder of a SKILL.md payload.
 *
 * @remarks
 * Returns null when the opening `---` fence is absent or malformed.
 */
function extractFrontmatterData(fileContent: string): {
  body: string;
  data: Record<string, unknown> | null;
} | null {
  const frontmatterMatch = fileContent.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
  );
  if (!frontmatterMatch || typeof frontmatterMatch[1] !== "string") {
    return null;
  }

  return {
    body: fileContent.slice(frontmatterMatch[0].length),
    data: loadYamlObject(frontmatterMatch[1]),
  };
}

/**
 * Loads optional `interface.short_description` from a skill's bundled OpenAI descriptor file.
 *
 * @remarks
 * I/O: reads `agents/openai.yaml` synchronously when the file exists beside SKILL.md.
 */
function extractOpenAiShortDescription(
  skillDirectoryPath: string,
): string | null {
  const openAiFilePath = path.join(
    skillDirectoryPath,
    SKILL_OPENAI_INTERFACE_FILE,
  );
  if (!fileExists(openAiFilePath)) {
    return null;
  }

  const openAiContent = readFileSync(openAiFilePath, "utf8");
  const yamlData = loadYamlObject(openAiContent);
  const interfaceData =
    yamlData?.interface &&
    typeof yamlData.interface === "object" &&
    !Array.isArray(yamlData.interface)
      ? (yamlData.interface as Record<string, unknown>)
      : null;

  return extractYamlStringValue(interfaceData, "short_description");
}

/**
 * Collapses internal whitespace so descriptions fit workflow frontmatter predictably.
 */
function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

/**
 * Builds a fallback description from the first SKILL body paragraph or a generic stub.
 */
function extractFallbackDescription(
  fileContent: string,
  skillName: string,
): string {
  const firstParagraphMatch = fileContent.match(
    /^#\s+.+\r?\n\r?\n(.+?)(?:\r?\n\r?\n|\r?\n#|$)/s,
  );
  if (firstParagraphMatch) {
    return normalizeDescription(firstParagraphMatch[1]);
  }

  return `Use the ${skillName} skill for the current task.`;
}

/**
 * Enumerates skill folders with SKILL.md and returns sorted definition records.
 *
 * @remarks
 * I/O: synchronous directory listings and reads. Drops folders missing SKILL.md.
 */
function collectSkillDefinitions(skillsDir: string): SkillDefinition[] {
  const directoryEntries = fs.readdirSync(skillsDir, { withFileTypes: true });

  return directoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry): SkillDefinition | null => {
      const skillName = entry.name;
      const skillDirectoryPath = path.join(skillsDir, skillName);
      const skillFilePath = path.join(
        skillDirectoryPath,
        SKILL_DEFINITION_FILE,
      );

      if (!fileExists(skillFilePath)) {
        return null;
      }

      const skillContent = readFileSync(skillFilePath, "utf8");
      const frontmatterData = extractFrontmatterData(skillContent);
      const resolvedSkillName =
        frontmatterData?.data &&
        extractYamlStringValue(frontmatterData.data, "name")
          ? extractYamlStringValue(frontmatterData.data, "name")
          : skillName;
      const fullDescription =
        frontmatterData?.data &&
        extractYamlStringValue(frontmatterData.data, "description")
          ? extractYamlStringValue(frontmatterData.data, "description")
          : extractFallbackDescription(
              frontmatterData?.body ?? skillContent,
              resolvedSkillName ?? skillName,
            );
      const shortDescription =
        extractOpenAiShortDescription(skillDirectoryPath);

      return {
        commandDescription: shortDescription ?? fullDescription ?? "",
        fullDescription: fullDescription ?? "",
        skillName,
        resolvedSkillName: resolvedSkillName ?? skillName,
        relativeSkillPath: path.posix.join(
          "skills",
          skillName,
          SKILL_DEFINITION_FILE,
        ),
        skillFileContent: skillContent,
      };
    })
    .filter(
      (skillDefinition): skillDefinition is SkillDefinition =>
        skillDefinition !== null,
    )
    .sort((left, right) => left.skillName.localeCompare(right.skillName));
}

/**
 * Materializes IDE workflow command content for one skill definition.
 *
 * @remarks
 * Produces Markdown + Mermaid plus Kimi-facing skill body routing metadata for `targets.ts`.
 */
function buildSkillWorkflowCommand(skillDefinition: SkillDefinition): Command {
  const canonicalSkillName = buildSkillCanonicalName(skillDefinition.skillName);
  const runCommandName = buildSkillRunCommandName(canonicalSkillName);
  const normalizedCommandDescription = normalizeDescription(
    skillDefinition.commandDescription,
  );
  const normalizedFullDescription = normalizeDescription(
    skillDefinition.fullDescription,
  );
  const frontmatterDescription =
    normalizedCommandDescription.length > 120
      ? normalizedCommandDescription.slice(0, 117).trimEnd() + "..."
      : normalizedCommandDescription;
  const title =
    normalizedCommandDescription.split(".")[0].trim() ||
    skillDefinition.resolvedSkillName;
  const shortTitle =
    title.length > 60 ? title.slice(0, 57).trimEnd() + "..." : title;
  const workflowContent = `---
description: ${toYamlQuotedString(frontmatterDescription)}
auto_execution_mode: 1
---

\`\`\`mermaid
flowchart TD
  A([BEGIN]) --> B["Receive user context"]
  B --> C["Load skill ${skillDefinition.resolvedSkillName}"]
  C --> D["${shortTitle}"]
  D --> E["Follow skill instructions"]
  E --> F["Apply skill to current task"]
  F --> G([END])
\`\`\`

# ${title}

Use the \`${skillDefinition.resolvedSkillName}\` repo-local skill for this turn.

## Skill Reference

- Skill: \`${skillDefinition.resolvedSkillName}\`
- Path: \`${skillDefinition.relativeSkillPath}\`
- Description: ${normalizedFullDescription}

Read \`${skillDefinition.relativeSkillPath}\` and follow that skill for this turn.
Resolve any referenced files relative to \`skills/${skillDefinition.skillName}/\`.


# Additional user context (if any)
\`\`\`
$ARGUMENTS
\`\`\`

`;

  return {
    name: runCommandName,
    description: frontmatterDescription,
    source: "skill",
    workflowContent,
    kimiSkillBody: skillDefinition.skillFileContent,
    kimiSkillFolder: canonicalSkillName,
  };
}

/**
 * End-to-end skill sync: locate skills tree, assemble commands, and push to IDE targets.
 *
 * @remarks
 * When `dryRun` is false, delegates filesystem writes to `syncCommandsToTargets`.
 */
function syncSkillWorkflows(dryRun: boolean): boolean {
  vlog("Starting skill workflow generation...");

  if (dryRun) {
    vlog("DRY RUN MODE - No files will be modified (use --write to apply)");
  }

  const skillsDir = findDirectory(POSSIBLE_SKILL_LOCATIONS, "skills directory");
  if (!skillsDir) {
    log("Cannot proceed: missing skills directory", "error");
    return false;
  }

  const skillDefinitions = collectSkillDefinitions(skillsDir);
  const commands = skillDefinitions.map((skillDefinition) =>
    buildSkillWorkflowCommand(skillDefinition),
  );
  const targets = buildDefaultTargetConfigs(process.cwd());

  vlog(`Found ${skillDefinitions.length} skills`);

  if (commands.length === 0) {
    log("No skill workflow shortcuts were generated", "error");
    return false;
  }

  const result = syncCommandsToTargets({
    commands,
    targets,
    dryRun,
    clearStrategy: "prefixes",
    // Include both legacy `skill-*`/`skills-*` and new `run-skill-*`/`run-skills-*` prefixes:
    // - Kimi target preserves canonical `skill-*`/`skills-*` folders (re-created with type:skill).
    // - Command/workflow targets clean both legacy and new prefixed entries before re-write.
    clearPrefixes: [
      SKILL_WORKFLOW_PREFIX,
      SKILLS_MANAGER_WORKFLOW_PREFIX,
      RUN_SKILL_WORKFLOW_PREFIX,
      RUN_SKILLS_MANAGER_WORKFLOW_PREFIX,
    ],
    log,
  });

  if (result.failedTargets > 0) {
    log(
      `${commands.length} skills × ${targets.length} targets — ${result.successTargets} ok, ${result.failedTargets} failed`,
      "error",
    );
    return false;
  }

  log(`${commands.length} skills × ${targets.length} targets — 0 errors`);
  return true;
}

const isDryRun = !process.argv.includes("--write");
syncSkillWorkflows(isDryRun);
