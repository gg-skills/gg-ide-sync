/**
 * @fileoverview Generates root IDE discovery wrappers for canonical workflows owned by submodule packages.
 *
 * Flow: discover configured submodules with `canonical-workflows/` folders -> parse package workflow markdown and frontmatter -> synthesize
 * submodule-prefixed discovery wrappers -> sync them to the shared root IDE targets without
 * treating the root repo as the canonical workflow source.
 *
 * @example
 * ```bash
 * # Preview generated wrappers without writing
 * npx tsx scripts/canonical-workflows/sync-submodule-discovery.ts
 *
 * # Write wrappers to all configured IDE targets
 * npx tsx scripts/canonical-workflows/sync-submodule-discovery.ts --write
 * ```
 *
 * @testing CLI manual: run `npx tsx scripts/canonical-workflows/sync-submodule-discovery.ts` from the repo root (optional `--write`) and verify prefixed discovery wrappers are previewed or written for the configured submodule workflow sources.
 * @see scripts/canonical-workflows/targets.ts - Shared multi-target workflow writer used for the generated discovery wrappers.
 * @see scripts/platform/lib/submodule-automation.ts - Shared submodule source discovery helper.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

import {
  buildDefaultTargetConfigs,
  type Command,
  normalizeDescription,
  syncCommandsToTargets,
} from "./targets";
import {
  PlatformSubmoduleAutomation_discoverPackages,
  type PlatformSubmoduleAutomation_Package,
} from "../platform/lib/submodule-automation";

const ROOT_DIR = process.cwd();

/**
 * Options for reading a single string field from parsed YAML frontmatter data.
 *
 * @remarks
 * `key` selects a frontmatter property; empty or whitespace-only strings normalize to null.
 */
type ExtractYamlStringValueOptions = {
  yamlData: Record<string, unknown> | null | undefined;
  key: string;
};

/**
 * Inputs needed to synthesize one IDE discovery `Command` for a package-owned workflow file.
 *
 * @remarks
 * `workflowContent` supplies description extraction; `workflowFileName` is the basename under
 * `canonical-workflows/`.
 */
type BuildDiscoveryWorkflowCommandOptions = {
  source: PlatformSubmoduleAutomation_Package;
  workflowContent: string;
  workflowFileName: string;
};

/**
 * Verbose toggle. Set `WORKFLOWS_SYNC_VERBOSE=1` (or legacy `SYNC_VERBOSE=1`) to
 * restore setup chatter. Errors and WARN lines are NEVER gated.
 */
const VERBOSE_LOG =
  process.env.WORKFLOWS_SYNC_VERBOSE === "1" ||
  process.env.SYNC_VERBOSE === "1";

/**
 * Emits a prefixed line to the appropriate console stream for this CLI script.
 *
 * @remarks
 * `info` is routine progress; `warn` and `error` are never silenced by verbose toggles elsewhere.
 */
function log(message: string, type: "info" | "warn" | "error" = "info"): void {
  const prefix = "[sync-workflows-submodule-discovery]";

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
 * Returns whether a path exists on disk, logging and returning false on unexpected errors.
 *
 * @remarks
 * I/O: synchronous `fs.existsSync` only; treat `false` as missing path or probe failure.
 */
function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error checking file existence for ${filePath}: ${message}`, "error");
    return false;
  }
}

/**
 * Narrows a value to a plain object usable as a string-keyed record (not arrays or null).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses YAML text into a record, or null when parsing fails or the root is not an object.
 *
 * @remarks
 * Logs parse failures at `warn` severity; non-object roots (scalars, sequences) yield null.
 */
function loadYamlObject(rawText: string): Record<string, unknown> | null {
  try {
    const loaded = yaml.load(rawText);
    if (!isRecord(loaded)) {
      return null;
    }
    return loaded;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error parsing YAML content: ${message}`, "warn");
    return null;
  }
}

/**
 * Splits leading YAML frontmatter from markdown when wrapped in `---` fences.
 *
 * @returns
 * Body after the closing fence and parsed frontmatter, or null when no valid block is found.
 */
function extractMarkdownFrontmatter(markdownContent: string): {
  body: string;
  data: Record<string, unknown> | null;
} | null {
  const frontmatterMatch = markdownContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch || typeof frontmatterMatch[1] !== "string") {
    return null;
  }

  return {
    body: markdownContent.slice(frontmatterMatch[0].length),
    data: loadYamlObject(frontmatterMatch[1]),
  };
}

/**
 * Reads a non-empty trimmed string from YAML data for a given key.
 *
 * @remarks
 * Missing keys, non-strings, and blank strings all yield null.
 */
function extractYamlStringValue(options: ExtractYamlStringValueOptions): string | null {
  const value = options.yamlData?.[options.key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

/**
 * Collects the first paragraph immediately following the first top-level `# ` heading.
 *
 * @remarks
 * Stops at blank lines that terminate the paragraph, the next heading, or end of file.
 */
function getFirstHeadingParagraph(markdownBody: string): string | null {
  const lines = markdownBody.replace(/\r\n/g, "\n").split("\n");
  const headingIndex = lines.findIndex((line) => line.startsWith("# "));
  if (headingIndex < 0) {
    return null;
  }

  const paragraphLines: string[] = [];
  for (let lineIndex = headingIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.trim() ?? "";
    if (line.length === 0) {
      if (paragraphLines.length > 0) {
        break;
      }
      continue;
    }
    if (line.startsWith("#")) {
      break;
    }
    paragraphLines.push(line);
  }

  return paragraphLines.length > 0 ? paragraphLines.join(" ") : null;
}

/**
 * Resolves a human-readable description for a canonical workflow file.
 * @remarks Falls back through frontmatter `description`, then the first paragraph
 * after the top-level heading, then a generic placeholder.
 */
function getCanonicalWorkflowDescription(workflowContent: string, workflowFileName: string): string {
  const frontmatter = extractMarkdownFrontmatter(workflowContent);
  const workflowBody = frontmatter ? frontmatter.body : workflowContent;
  const frontmatterDescription = extractYamlStringValue({
    yamlData: frontmatter?.data,
    key: "description",
  });

  if (frontmatterDescription) {
    return normalizeDescription(frontmatterDescription);
  }

  const firstHeadingParagraph = getFirstHeadingParagraph(workflowBody);
  if (firstHeadingParagraph) {
    return normalizeDescription(firstHeadingParagraph);
  }

  return `Discover canonical workflow ${path.basename(workflowFileName, ".md")}`;
}

/**
 * Lists `.md` workflow filenames (excluding `.gitkeep`) from a package `canonical-workflows` dir.
 *
 * @remarks
 * I/O: directory read is synchronous; failures log at `error` and return an empty list.
 */
function getCanonicalWorkflowFiles(workflowsDirPath: string): string[] {
  try {
    return fs
      .readdirSync(workflowsDirPath)
      .filter((fileName) => fileName.endsWith(".md") && fileName !== ".gitkeep")
      .sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Error reading submodule workflow directory ${workflowsDirPath}: ${message}`, "error");
    return [];
  }
}

/**
 * Builds the markdown body stored inside a generated root IDE “discovery wrapper” workflow.
 *
 * @remarks
 * The output points operators at the package-owned canonical path and discourages editing the
 * generated file.
 */
function buildDiscoveryWorkflowContent(options: {
  canonicalDescription: string;
  canonicalWorkflowName: string;
  packageDir: string;
  packageDisplayName: string;
  workflowRelPath: string;
}): string {
  return `# ${options.packageDisplayName}: ${options.canonicalWorkflowName}

This is a generated root discovery wrapper. The canonical workflow is owned by the
\`${options.packageDisplayName}\` package and must be executed from that package root or from a
standalone clone of that package.

## Canonical workflow

- Package: \`${options.packageDisplayName}\`
- Path relative to the root repo: \`${options.workflowRelPath}\`

## Canonical description

${options.canonicalDescription}

## Required execution location

Run the canonical workflow from:

\`\`\`bash
cd ${options.packageDir}
\`\`\`

Then open and follow:

\`\`\`text
canonical-workflows/${options.canonicalWorkflowName}.md
\`\`\`

## Why this wrapper exists

- keep root-level workflow discovery available without making the root repo a duplicate canonical
  source
- point to the exact package-owned workflow path so path updates stay centralized
- prevent drift between root IDE targets and the package workflow files

## Editing policy

- Do not edit this generated discovery wrapper directly.
- Edit the canonical package workflow instead:
  \`${options.workflowRelPath}\`
`;
}

/**
 * Assembles one `Command` entry (prefixed name, description, generated markdown) for target sync.
 *
 * @remarks
 * Derives display metadata via `getCanonicalWorkflowDescription` and embeds navigation text via
 * `buildDiscoveryWorkflowContent`.
 */
function buildDiscoveryWorkflowCommand(
  options: BuildDiscoveryWorkflowCommandOptions,
): Command {
  const workflowName = path.basename(options.workflowFileName, ".md");
  const workflowRelPath = path.join(
    options.source.packageDir,
    "canonical-workflows",
    options.workflowFileName,
  );
  const canonicalDescription = getCanonicalWorkflowDescription(
    options.workflowContent,
    options.workflowFileName,
  );

  return {
    name: `${options.source.discoveryWorkflowPrefix}${workflowName}`,
    description: `Discover package workflow ${workflowName} in ${options.source.packageDisplayName}`,
    source: "submodule workflow discovery",
    workflowContent: buildDiscoveryWorkflowContent({
      canonicalDescription,
      canonicalWorkflowName: workflowName,
      packageDir: options.source.packageDir,
      packageDisplayName: options.source.packageDisplayName,
      workflowRelPath,
    }),
  };
}

/**
 * Enumerates canonical workflow markdown for one opted-in package and builds discovery commands.
 *
 * @remarks
 * Skips missing dirs or empty directories with `warn` logs; unreadable files log `error` and are
 * omitted. I/O: synchronous reads under `packageRoot/canonical-workflows`.
 */
function collectSourceCommands(source: PlatformSubmoduleAutomation_Package): Command[] {
  const workflowsDirPath = path.join(source.packageRoot, "canonical-workflows");
  if (!fileExists(workflowsDirPath)) {
    log(
      `Skipping ${source.packageDisplayName}: canonical workflow directory is missing at ${workflowsDirPath}`,
      "warn",
    );
    return [];
  }

  const workflowFiles = getCanonicalWorkflowFiles(workflowsDirPath);
  if (workflowFiles.length === 0) {
    log(
      `No canonical workflow markdown files found for ${source.packageDisplayName} at ${workflowsDirPath}`,
      "warn",
    );
    return [];
  }

  return workflowFiles.flatMap((workflowFileName) => {
    const workflowPath = path.join(workflowsDirPath, workflowFileName);

    try {
      const workflowContent = fs.readFileSync(workflowPath, "utf8");
      return [
        buildDiscoveryWorkflowCommand({
          source,
          workflowContent,
          workflowFileName,
        }),
      ];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Error reading canonical workflow ${workflowPath}: ${message}`, "error");
      return [];
    }
  });
}

/**
 * Orchestrates discovery-wrapper generation for all opted-in submodule packages.
 * @returns `true` when every target syncs without failures, `false` otherwise.
 */
function syncSubmoduleDiscoveryWorkflows(dryRun: boolean): boolean {
  vlog("Starting submodule workflow discovery sync...");

  if (dryRun) {
    vlog("DRY RUN MODE - No files will be modified (use --write to apply)");
  }

  const targets = buildDefaultTargetConfigs(process.cwd());
  const sources = PlatformSubmoduleAutomation_discoverPackages({
    feature: "canonicalWorkflows",
    log,
    rootDir: ROOT_DIR,
  });
  let sawFailure = false;

  if (sources.length === 0) {
    log("No configured submodules expose canonical workflow discovery sources", "warn");
    return true;
  }

  for (const source of sources) {
    const commands = collectSourceCommands(source);

    if (commands.length === 0) {
      // collectSourceCommands already emitted a WARN explaining why; skip the
      // per-target zero-summary lines and the success summary entirely.
      continue;
    }

    vlog(
      `Prepared ${commands.length} generated discovery workflow wrappers for ${source.packageDisplayName}`,
    );

    const result = syncCommandsToTargets({
      commands,
      targets,
      dryRun,
      clearStrategy: "prefixes",
      clearPrefixes: [source.discoveryWorkflowPrefix],
      log,
    });

    if (result.failedTargets > 0) {
      sawFailure = true;
      log(
        `${source.packageDisplayName}: ${commands.length} wrappers × ${targets.length} targets — ${result.successTargets} ok, ${result.failedTargets} failed`,
        "error",
      );
    } else {
      log(
        `${source.packageDisplayName}: ${commands.length} wrappers × ${targets.length} targets — 0 errors`,
      );
    }
  }

  return !sawFailure;
}

/**
 * CLI entrypoint: default dry-run unless `--write`; exits 1 when any target sync fails.
 */
function main(): void {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--write");

  const success = syncSubmoduleDiscoveryWorkflows(dryRun);
  process.exit(success ? 0 : 1);
}

main();
