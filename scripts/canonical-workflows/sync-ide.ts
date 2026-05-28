/**
 * @fileoverview Publishes manual `canonical-workflows/*.md` definitions into IDE command surfaces.
 *
 * Flow: locate canonical `canonical-workflows/` → parse markdown + frontmatter → build `Command[]`
 * → assert each command name carries the mandatory `wf-` prefix → dry-run or write via
 * `syncCommandsToTargets` with manual-only clear strategy.
 * Invariant: source filenames must be `wf-<slug>.md`; the soft warning in `getManualWorkflowFiles`
 * flags drift early, and `assertCanonicalWorkflowProjectionName` rejects any non-conforming command
 * before it reaches a target writer.
 *
 * @example
 * // Preview changes without writing
 * npx tsx scripts/canonical-workflows/sync-ide.ts
 *
 * // Apply changes to all IDE targets
 * npx tsx scripts/canonical-workflows/sync-ide.ts --write
 *
 * @testing CLI manual: run `npx tsx scripts/canonical-workflows/sync-ide.ts` from the repo root (optional `--write`).
 * @see scripts/canonical-workflows/targets.ts - Shared workflow target routing helpers and the `CANONICAL_WORKFLOW_PROJECTION_PREFIX` invariant enforced here.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

import {
  buildDefaultTargetConfigs,
  CANONICAL_WORKFLOW_PROJECTION_PREFIX,
  type Command,
  GENERATED_WORKFLOW_PREFIXES,
  syncCommandsToTargets,
} from "./targets";

const WORKFLOWS_DIR = "canonical-workflows";
const POSSIBLE_WORKFLOW_LOCATIONS = [
  path.join(process.cwd(), WORKFLOWS_DIR),
];

/**
 * Verbose toggle. Set `WORKFLOWS_SYNC_VERBOSE=1` (or legacy `SYNC_VERBOSE=1`) to
 * restore setup chatter and per-file "Prepared canonical workflow command" lines.
 * Errors and warnings are NEVER gated.
 */
const VERBOSE_LOG =
  process.env.WORKFLOWS_SYNC_VERBOSE === "1" ||
  process.env.SYNC_VERBOSE === "1";

/**
 * Emits a prefixed line to the appropriate console stream for this sync CLI.
 *
 * @remarks
 * I/O: writes to `console.log`, `console.warn`, or `console.error` depending on `type`.
 * Errors and warnings are never suppressed by `WORKFLOWS_SYNC_VERBOSE`.
 *
 * @param message - Human-readable line body after the script prefix.
 * @param type - Stream selector; defaults to info-level stdout logging.
 */
function log(message: string, type: "info" | "warn" | "error" = "info"): void {
  const prefix = "[sync-workflows-ide]";

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
 * Best-effort synchronous existence probe for a filesystem path.
 *
 * @remarks
 * I/O: `fs.existsSync`. On unexpected read failures, logs an error and returns false so sync can continue with other candidates.
 *
 * @param filePath - Path to test.
 * @returns True when the path exists; false when missing or when existence could not be determined safely.
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
 * Locates the `canonical-workflows/` directory by scanning fixed candidate paths.
 *
 * @remarks
 * I/O: synchronous directory existence checks only. Emits `vlog` traces and warns with every checked path when none match.
 *
 * @returns Absolute or relative directory path that exists, or null when no candidate matches.
 */
function findWorkflowsDir(): string | null {
  vlog("Searching for canonical workflows directory...");

  for (const dirPath of POSSIBLE_WORKFLOW_LOCATIONS) {
    if (fileExists(dirPath)) {
      vlog(`Found canonical workflows directory at: ${dirPath}`);
      return dirPath;
    }
  }

  log("Could not find workflows directory. Checked locations:", "warn");
  POSSIBLE_WORKFLOW_LOCATIONS.forEach((directoryPath) =>
    log(`  - ${directoryPath}`, "warn"),
  );
  return null;
}

/**
 * Parses a YAML document string into a plain object record for frontmatter consumption.
 *
 * @remarks
 * PURITY: local parsing only — returns null for empty documents, arrays, primitives, or parse failures (warns on YAML errors).
 *
 * @param rawText - YAML source extracted from an `---` fenced block.
 * @returns A non-array object record, or null when the document is unusable for frontmatter key lookups.
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
    log(`Error parsing YAML content: ${msg}`, "warn");
    return null;
  }
}

/**
 * Splits leading YAML frontmatter from the remainder of a markdown workflow file.
 *
 * @remarks
 * Expects the file to open with `---`, a YAML body, then a closing `---` before Markdown content.
 *
 * @param markdownContent - Full file text including optional frontmatter fence.
 * @returns Body after the closing fence plus parsed frontmatter data, or null when no opening fence matches.
 */
function extractMarkdownFrontmatter(markdownContent: string): {
  body: string;
  data: Record<string, unknown> | null;
} | null {
  const frontmatterMatch = markdownContent.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
  );
  if (!frontmatterMatch || typeof frontmatterMatch[1] !== "string") {
    return null;
  }

  return {
    body: markdownContent.slice(frontmatterMatch[0].length),
    data: loadYamlObject(frontmatterMatch[1]),
  };
}

/**
 * Reads a single string field from parsed frontmatter, ignoring empty or whitespace-only values.
 *
 * @param yamlData - Parsed YAML object from `extractMarkdownFrontmatter`, when present.
 * @param key - Frontmatter key to read.
 * @returns Trimmed non-empty string, or null when absent or not a string.
 */
function extractYamlStringValue(
  yamlData: Record<string, unknown> | null | undefined,
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
 * Normalizes free-text workflow descriptions to a single-line, whitespace-collapsed form.
 *
 * @param description - Raw description from frontmatter or extracted markdown heading text.
 * @returns A trimmed string with internal whitespace runs collapsed to single spaces.
 */
function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

/**
 * Lists manual `*.md` workflow filenames under the canonical workflows directory.
 *
 * @remarks
 * I/O: synchronous directory read. Filters out generated-prefix files, warns when those appear, and logs (error) when manual files lack the mandatory `wf-` prefix while still returning the full list so violations surface in one pass; hard failure occurs later via `assertCanonicalWorkflowProjectionName`.
 *
 * @param workflowsDirPath - Resolved workflows directory, or null when discovery failed upstream.
 * @returns Basenames only; empty when the path is null or the directory cannot be read.
 */
function getManualWorkflowFiles(workflowsDirPath: string | null): string[] {
  if (!workflowsDirPath) {
    log("Workflows directory path is null", "error");
    return [];
  }

  try {
    const files = fs
      .readdirSync(workflowsDirPath)
      .filter((file) => file.endsWith(".md"));
    const generatedFiles = files.filter((file) =>
      GENERATED_WORKFLOW_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );

    if (generatedFiles.length > 0) {
      log(
        `Ignoring ${generatedFiles.length} generated workflow files found in canonical-workflows/: ${generatedFiles.slice(0, 5).join(", ")}${generatedFiles.length > 5 ? ", ..." : ""}`,
        "warn",
      );
    }

    const manualFiles = files.filter(
      (file) =>
        !GENERATED_WORKFLOW_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );
    // Soft warning for the `wf-` source-file invariant. We intentionally still
    // return `manualFiles` here so the caller can surface ALL violations in one
    // sync run; the hard guarantee is enforced downstream by
    // `assertCanonicalWorkflowProjectionName`, which throws before any target
    // write occurs.
    const nonPrefixedFiles = manualFiles.filter(
      (file) => !file.startsWith(CANONICAL_WORKFLOW_PROJECTION_PREFIX),
    );
    if (nonPrefixedFiles.length > 0) {
      log(
        `Found ${nonPrefixedFiles.length} canonical workflow file(s) missing the mandatory "${CANONICAL_WORKFLOW_PROJECTION_PREFIX}" prefix in ${workflowsDirPath}: ${nonPrefixedFiles.slice(0, 5).join(", ")}${nonPrefixedFiles.length > 5 ? ", ..." : ""}. Rename them or sync will throw at write time.`,
        "error",
      );
    }
    return manualFiles;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(
      `Error reading workflows directory ${workflowsDirPath}: ${msg}`,
      "error",
    );
    return [];
  }
}

/**
 * Validates that a workflow file has non-empty content before projection.
 *
 * @param workflowContent - Full file text loaded from disk.
 * @param fileName - Source basename included in warning text.
 * @returns False when content is empty (warns); true otherwise.
 */
function validateWorkflow(workflowContent: string, fileName: string): boolean {
  if (!workflowContent) {
    log(`Workflow ${fileName} is empty`, "warn");
    return false;
  }

  return true;
}

/**
 * Derives projected command metadata from a canonical workflow markdown file.
 *
 * @remarks
 * Prefers `description` frontmatter; otherwise scrapes the first paragraph after the title, else falls back to a generic label. Projected `name` lowercases the `wf-<slug>.md` basename and slugifies non-alphanumeric characters; prefix enforcement is deferred to `assertCanonicalWorkflowProjectionName`.
 *
 * @param workflowContent - Full markdown including optional YAML frontmatter.
 * @param fileName - Workflow basename (for logging context and name derivation).
 * @returns Object shaped for building a `Command` row (plus raw `workflowContent` for target writers).
 */
function extractWorkflowInfo(
  workflowContent: string,
  fileName: string,
): {
  name: string;
  description: string;
  source: string;
  workflowContent: string;
} {
  const workflowName = path.basename(fileName, ".md");
  const frontmatter = extractMarkdownFrontmatter(workflowContent);
  const workflowBody = frontmatter ? frontmatter.body : workflowContent;
  const frontmatterDescription = extractYamlStringValue(
    frontmatter?.data,
    "description",
  );
  const descriptionMatch = workflowBody.match(
    /^#\s+.+\r?\n\r?\n(.+?)(?:\r?\n\r?\n|\r?\n#|$)/s,
  );
  const description = frontmatterDescription
    ? normalizeDescription(frontmatterDescription)
    : descriptionMatch
      ? normalizeDescription(descriptionMatch[1])
      : `Run ${workflowName} workflow`;

  // Canonical workflow source files are mandated to live on disk as `wf-<slug>.md`.
  // The projected name reuses that filename verbatim (lowercased, slugified for safety).
  // No prefix is synthesized here — `assertCanonicalWorkflowProjectionName` rejects any
  // source file that lacks the prefix at write time.
  const projectedName = workflowName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return {
    name: projectedName,
    description,
    source: "workflow",
    workflowContent,
  };
}

/**
 * Asserts that a projected command name carries the mandatory `wf-` prefix.
 *
 * @remarks
 * INVARIANT: every `Command` emitted by this script must begin with
 * `CANONICAL_WORKFLOW_PROJECTION_PREFIX`. Because the projected name is derived
 * verbatim from the source filename (no prefix is synthesized at projection
 * time), this assertion really enforces that the source file in
 * `canonical-workflows/` was named `wf-<slug>.md`.
 *
 * PURITY: pure validation — throws on violation, returns void on success. No
 * I/O, no mutation, no logging. Callers may rely on this being safe to invoke
 * inside a tight loop before each target write.
 *
 * USAGE: must run for every command before it reaches `syncCommandsToTargets`,
 * so that stale projections in target dirs always carry a known-safe prefix
 * for cleanup, and so that `run-npm-*`, `run-skill-*`, and `run-skills-*`
 * lanes never collide with canonical-workflow output.
 *
 * @param command - The projected command row whose `name` is checked against the prefix.
 * @param sourceFileName - The source filename from `canonical-workflows/`; included in the error message so the caller can rename the offending file directly.
 * @throws {Error} When `command.name` does not start with `CANONICAL_WORKFLOW_PROJECTION_PREFIX`. The error message names the source file and the rename action required to fix it.
 *
 * @see {@link CANONICAL_WORKFLOW_PROJECTION_PREFIX} - Source-of-truth prefix constant enforced by this assertion.
 */
function assertCanonicalWorkflowProjectionName(
  command: Command,
  sourceFileName: string,
): void {
  if (!command.name.startsWith(CANONICAL_WORKFLOW_PROJECTION_PREFIX)) {
    throw new Error(
      `[sync-workflows-ide] Canonical workflow source file must be named "${CANONICAL_WORKFLOW_PROJECTION_PREFIX}<slug>.md" — got source "${sourceFileName}" projecting to "${command.name}". This invariant is mandatory across all targets. Rename the file in canonical-workflows/ to start with "${CANONICAL_WORKFLOW_PROJECTION_PREFIX}".`,
    );
  }
}

/**
 * Materializes `Command` rows for every manual workflow file under `workflowsDir`.
 *
 * @remarks
 * I/O: synchronous per-file reads. Skips invalid/empty files, logs per-file failures without aborting the batch, and asserts the mandatory `wf-` projection prefix before enqueueing each command.
 *
 * @param workflowFiles - Manual markdown basenames produced by `getManualWorkflowFiles`.
 * @param workflowsDir - Directory containing those files.
 * @returns Commands ready for `syncCommandsToTargets` writes or dry-run previews.
 */
function generateManualWorkflowCommands(
  workflowFiles: string[],
  workflowsDir: string,
): Command[] {
  const commands: Command[] = [];

  for (const file of workflowFiles) {
    const filePath = path.join(workflowsDir, file);

    try {
      const workflowContent = fs.readFileSync(filePath, "utf8");
      if (!validateWorkflow(workflowContent, file)) {
        continue;
      }

      const workflowInfo = extractWorkflowInfo(workflowContent, file);
      const command: Command = {
        name: workflowInfo.name,
        description: workflowInfo.description,
        source: workflowInfo.source,
        workflowContent: workflowInfo.workflowContent,
      };
      assertCanonicalWorkflowProjectionName(command, file);
      commands.push(command);
      vlog(`Prepared canonical workflow command: ${workflowInfo.name}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`Error processing workflow file ${file}: ${msg}`, "error");
    }
  }

  return commands;
}

/**
 * CLI entry: discovers workflows, builds commands, and delegates to multi-IDE sync.
 *
 * @remarks
 * I/O: filesystem discovery and `syncCommandsToTargets` writes when `dryRun` is false. Returns false when the workflows directory is missing or any target reports failure counts.
 *
 * @param dryRun - When true, runs `syncCommandsToTargets` in preview mode without mutating targets.
 * @returns True on full success across targets; false when prerequisites fail or any target errors.
 */
function syncIdeWorkflows(dryRun: boolean): boolean {
  vlog("Starting IDE workflow synchronization...");

  if (dryRun) {
    vlog("DRY RUN MODE - No files will be modified (use --write to apply)");
  }

  const workflowsDir = findWorkflowsDir();
  if (!workflowsDir) {
    log("Cannot proceed: missing workflows directory", "error");
    return false;
  }

  const workflowFiles = getManualWorkflowFiles(workflowsDir);
  vlog(`Found ${workflowFiles.length} canonical manual workflow files`);

  const commands = generateManualWorkflowCommands(workflowFiles, workflowsDir);
  const targets = buildDefaultTargetConfigs(process.cwd());

  const result = syncCommandsToTargets({
    commands,
    targets,
    dryRun,
    clearStrategy: "manual",
    log,
  });

  if (result.failedTargets > 0) {
    log(
      `${commands.length} workflows × ${targets.length} targets — ${result.successTargets} ok, ${result.failedTargets} failed`,
      "error",
    );
    return false;
  }

  log(`${commands.length} workflows × ${targets.length} targets — 0 errors`);
  return true;
}

const isDryRun = !process.argv.includes("--write");
syncIdeWorkflows(isDryRun);
