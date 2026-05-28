/**
 * @fileoverview Syncs root harness-specific guidance runtime artifacts from shared `AGENTS.md`
 * plus harness-authored delta files.
 *
 * The current implementation materializes the Codex target by generating `AGENTS.CODEX.md` from
 * `AGENTS.md` + `CODEX.md`, then wiring `.codex/config.toml` to that merged file via
 * `model_instructions_file` while preserving unrelated local Codex config such as MCP servers.
 *
 * @example
 * ```typescript
 * const report = syncAgentsGuidance({
 *   mode: "write",
 *   repoRoot: "/path/to/repo",
 *   targetIds: ["codex"],
 * });
 * ```
 *
 * @testing Jest unit: NODE_OPTIONS='--experimental-vm-modules' npx jest --config jest.config.ts scripts/__tests__/agents-guidance.unit.test.ts
 * @see scripts/agents-guidance/generate.ts - CLI entrypoint that calls these helpers.
 * @see scripts/worktree-stack/lib/local-state.ts - Prepared-worktree local-state sync that copies generated Codex guidance runtime artifacts.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Operational mode for agents-guidance sync.
 *
 * @remarks
 * - `"check"` reports drift without writing files.
 * - `"dry-run"` previews the actions that would be taken.
 * - `"write"` applies generated guidance files and config updates.
 */
export type AgentsGuidanceMode = "check" | "dry-run" | "write";

/**
 * Supported harness identifier for agents-guidance generation.
 *
 * @remarks
 * Currently only `"codex"` is registered in `AGENTS_GUIDANCE_TARGETS`.
 */
export type AgentsGuidanceTargetId = "codex";

/**
 * Per-target result summarizing file changes, drift count, and fatal errors.
 */
export type AgentsGuidanceTargetReport = {
  changes: string[];
  driftDetected: number;
  errors: string[];
  targetId: AgentsGuidanceTargetId;
};

/**
 * Aggregate report across all requested targets with summed changes, drift, and errors.
 */
export type AgentsGuidanceReport = {
  targets: AgentsGuidanceTargetReport[];
  totalChanges: number;
  totalDriftDetected: number;
  totalErrors: number;
};

/**
 * Describes filenames for one agents-guidance harness: authored delta input and generated output.
 *
 * @remarks
 * Used by `AGENTS_GUIDANCE_TARGETS` to map stable harness identifiers onto repo-relative paths.
 */
type AgentsGuidanceTargetDefinition = {
  authoredDeltaFileName: string;
  generatedFileName: string;
  id: AgentsGuidanceTargetId;
};

const ROOT_GUIDANCE_FILE_NAME = "AGENTS.md";
const CODEX_CONFIG_FILE_NAME = path.join(".codex", "config.toml");

const AGENTS_GUIDANCE_TARGETS: readonly AgentsGuidanceTargetDefinition[] = [
  {
    authoredDeltaFileName: "CODEX.md",
    generatedFileName: "AGENTS.CODEX.md",
    id: "codex",
  },
] as const;

/**
 * Escapes RegExp metacharacters so a filesystem path can be embedded as a literal segment.
 *
 * @remarks
 * PURITY: string transform only; used when building boundary-aware workspace path patterns.
 *
 * @param value - Raw substring that must not activate regex operators.
 * @returns The same text with regex-special characters backslash-escaped.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Locates the first TOML section header (`[section]`) in a split config file.
 *
 * @remarks
 * PURITY: scans lines only; separates Codex `config.toml` preamble from table sections.
 *
 * @param lines - Lines after newline normalization.
 * @returns Index of the first section line, or `-1` when the preamble has no sections.
 */
function findFirstSectionIndex(lines: string[]): number {
  return lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/u.test(line));
}

/**
 * Removes trailing blank-only lines from a copied line array.
 *
 * @remarks
 * PURITY: pops from the end of a shallow clone until the last line is non-empty.
 *
 * @param lines - Typically preamble or whole-file lines before re-joining.
 * @returns A new array without trailing empty or whitespace-only lines.
 */
function trimTrailingEmptyLines(lines: string[]): string[] {
  const nextLines = [...lines];
  while (nextLines.length > 0 && nextLines.at(-1)?.trim().length === 0) {
    nextLines.pop();
  }
  return nextLines;
}

/**
 * Builds the HTML comment banner prepended to generated agents-guidance markdown.
 *
 * @remarks
 * PURITY: string assembly; encodes regeneration command and authoritative source filenames.
 *
 * @param sourceFiles - Repo-relative names of inputs merged into the artifact.
 * @returns Comment lines plus a trailing blank line before body content.
 */
function buildGeneratedFileBanner(sourceFiles: readonly string[]): string {
  return [
    "<!-- GENERATED FILE. DO NOT EDIT DIRECTLY. -->",
    `<!-- Source files: ${sourceFiles.join(", ")} -->`,
    "<!-- Regenerate with: npm run agents:sync -->",
    "",
  ].join("\n");
}

/**
 * Resolves a harness id to its registered target definition.
 *
 * @remarks
 * PURITY: array lookup; callers must use ids validated by `parseTargetList` or literals.
 *
 * @param targetId - Registered harness identifier.
 * @returns Static path mapping for delta input and generated output.
 * @throws Error when the id is not present in `AGENTS_GUIDANCE_TARGETS`.
 */
function getTargetDefinition(targetId: AgentsGuidanceTargetId): AgentsGuidanceTargetDefinition {
  const target = AGENTS_GUIDANCE_TARGETS.find((candidateTarget) => candidateTarget.id === targetId);
  if (!target) {
    throw new Error(`Unsupported agents-guidance target: ${targetId}`);
  }

  return target;
}

/**
 * Reads a UTF-8 file that must exist for sync to proceed.
 *
 * @remarks
 * I/O: synchronous read; rejects directories and missing paths with explicit errors.
 *
 * @param filePath - Absolute or repo-root-resolved file to load.
 * @returns Decoded file contents.
 * @throws Error when the path is missing or not a regular file.
 */
function readRequiredFile(filePath: string): string {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing required file: ${filePath}`);
  }

  return fs.readFileSync(filePath, "utf8");
}

/**
 * Reads a UTF-8 file when present, or returns null without throwing.
 *
 * @remarks
 * I/O: synchronous existence check and read; null when absent or not a file.
 *
 * @param filePath - Absolute or repo-root-resolved path to probe.
 * @returns File contents, or null when there is nothing to read.
 */
function readOptionalFile(filePath: string): string | null {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }

  return fs.readFileSync(filePath, "utf8");
}

/**
 * Normalizes newline endings and trailing newline shape for guidance text comparisons.
 *
 * @remarks
 * PURITY: converts CR/CRLF to LF; ensures every non-empty payload ends with a single newline.
 *
 * @param value - Raw text prior to merge or drift normalization.
 */
function normalizeTextContent(value: string): string {
  const normalizedLineEndings = value.replace(/\r\n?/gu, "\n");
  return normalizedLineEndings.length === 0 || normalizedLineEndings.endsWith("\n")
    ? normalizedLineEndings
    : `${normalizedLineEndings}\n`;
}

/**
 * Removes trailing whitespace from the string tail without altering interior line content.
 *
 * @remarks
 * PURITY: delegates to `String.prototype.trimEnd` semantics for whole-string trimming only.
 *
 * @param value - Text whose trailing blanks should be stripped before merging sections.
 */
function trimTrailingBlankLines(value: string): string {
  return value.trimEnd();
}

/**
 * Guarantees the payload ends with exactly one newline when it is non-empty after prior normalization.
 *
 * @remarks
 * PURITY: appends `\n` only when missing.
 *
 * @param value - Content that must terminate with a newline for written artifacts.
 * @returns Same reference when already newline-terminated; otherwise newline-suffixed copy.
 */
function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

/**
 * Merges canonical `AGENTS.md` content with Codex-specific `CODEX.md` delta into a single
 * generated guidance file, normalizing trailing whitespace and prepending a generated-file banner.
 *
 * @remarks
 * I/O: reads no files directly; operates on already-loaded string content.
 * The banner warns that the file is generated and lists source files plus the regeneration command.
 *
 * @param options.agentsContent - Raw content from the root `AGENTS.md`.
 * @param options.codexContent - Raw content from the harness-authored `CODEX.md` delta file.
 * @returns Normalized merged guidance with generated-file banner and trailing newline.
 */
export function buildCodexGuidanceContent(options: {
  agentsContent: string;
  codexContent: string;
}): string {
  const canonicalAgentsContent = trimTrailingBlankLines(
    normalizeTextContent(options.agentsContent),
  );
  const codexOnlyContent = trimTrailingBlankLines(normalizeTextContent(options.codexContent));

  const mergedContent = [
    buildGeneratedFileBanner([ROOT_GUIDANCE_FILE_NAME, "CODEX.md"]).trimEnd(),
    "",
    canonicalAgentsContent,
    "",
    "<!-- Codex-specific guidance from CODEX.md -->",
    "",
    codexOnlyContent,
  ].join("\n");

  return ensureTrailingNewline(mergedContent);
}

/**
 * Rewrites the `model_instructions_file` key in `.codex/config.toml` preamble while preserving
 * all TOML sections and unrelated config keys such as MCP server entries.
 *
 * @remarks
 * I/O: manipulates TOML-like string content; does not read or write the filesystem directly.
 * The guidance file path MUST be absolute; a relative path triggers an explicit Error.
 * When `guidanceFilePath` is `null`, the key is removed rather than updated.
 *
 * @param options.guidanceFilePath - Absolute path to the generated guidance file, or `null` to remove.
 * @param options.rawConfigContent - Existing `.codex/config.toml` content.
 * @returns Updated config content with normalized trailing newline.
 * @throws Error when `guidanceFilePath` is relative rather than absolute.
 */
export function updateCodexConfigContent(options: {
  guidanceFilePath: string | null;
  rawConfigContent: string;
}): string {
  const normalizedContent = normalizeTextContent(options.rawConfigContent);
  const lines = normalizedContent.length > 0
    ? normalizedContent.replace(/\n$/u, "").split("\n")
    : [];
  const firstSectionIndex = findFirstSectionIndex(lines);
  const preambleLines = (firstSectionIndex === -1 ? lines : lines.slice(0, firstSectionIndex))
    .filter((line) => !/^\s*model_instructions_file\s*=/u.test(line));
  const sectionLines = firstSectionIndex === -1 ? [] : lines.slice(firstSectionIndex);
  const nextPreambleLines = trimTrailingEmptyLines(preambleLines);

  if (options.guidanceFilePath !== null) {
    if (!path.isAbsolute(options.guidanceFilePath)) {
      throw new Error(
        `Codex model_instructions_file must be absolute: ${options.guidanceFilePath}`,
      );
    }

    if (
      nextPreambleLines.length > 0
      && nextPreambleLines.at(-1)?.trim().length !== 0
    ) {
      nextPreambleLines.push("");
    }

    nextPreambleLines.push(
      `model_instructions_file = ${JSON.stringify(options.guidanceFilePath)}`,
    );
  }

  const outputLines = [...nextPreambleLines];
  if (
    outputLines.length > 0
    && sectionLines.length > 0
    && outputLines.at(-1)?.trim().length !== 0
  ) {
    outputLines.push("");
  }
  outputLines.push(...sectionLines);

  if (outputLines.length === 0) {
    return "";
  }

  return ensureTrailingNewline(outputLines.join("\n"));
}

/**
 * Replaces every occurrence of a source workspace absolute path with a target workspace absolute
 * path inside arbitrary text content, respecting word boundaries after the path.
 *
 * @remarks
 * I/O: pure string transform; no filesystem interaction.
 * Both paths are resolved via `path.resolve` before substitution.
 * The regex ensures the match ends at a path boundary (`/`, `"`, `'`, `\s`, or end-of-string)
 * to avoid partial directory-name matches.
 *
 * @param options.content - Text content that may contain absolute workspace paths.
 * @param options.sourceWorkspacePath - Workspace path to search for.
 * @param options.targetWorkspacePath - Workspace path to substitute.
 * @returns Content with all matched source workspace paths replaced.
 */
export function rewriteWorkspaceAbsolutePathsInTextContent(options: {
  content: string;
  sourceWorkspacePath: string;
  targetWorkspacePath: string;
}): string {
  const normalizedSourceWorkspacePath = path.resolve(options.sourceWorkspacePath);
  const normalizedTargetWorkspacePath = path.resolve(options.targetWorkspacePath);
  const workspacePathPattern = new RegExp(
    `${escapeRegExp(normalizedSourceWorkspacePath)}(?=$|[/"'\\s])`,
    "gu",
  );

  return options.content.replace(workspacePathPattern, normalizedTargetWorkspacePath);
}

/**
 * Compares optional file payloads after newline normalization used for drift detection.
 *
 * @remarks
 * PURITY: delegates to `normalizeTextContent` for both sides; treats null as distinct from empty.
 *
 * @param existingContent - Current disk content when present, or null when absent.
 * @param desiredContent - Intended payload after sync, or null when the file should be absent.
 * @returns True when normalized forms match and no write would change bytes on disk.
 */
function compareTextFileContent(
  existingContent: string | null,
  desiredContent: string | null,
): boolean {
  const normalizedExisting = existingContent === null ? null : normalizeTextContent(existingContent);
  const normalizedDesired = desiredContent === null ? null : normalizeTextContent(desiredContent);

  return normalizedExisting === normalizedDesired;
}

/**
 * Applies or previews a single text artifact update for one agents-guidance sync step.
 *
 * @remarks
 * I/O: reads optionally; in write mode creates parent dirs, writes UTF-8, or deletes when desired
 * content is null.
 * Increments drift when content differs; records human-readable change entries on every branch.
 *
 * @param options.desiredContent - Target file body, or null to remove the path when allowed.
 * @param options.filePath - Absolute path of the file to inspect or mutate.
 * @param options.label - Short repo-relative label surfaced in reports.
 * @param options.mode - `"check"` counts drift only; `"dry-run"` logs intent; `"write"` applies.
 * @param options.report - Mutable per-target accumulator for drift and change lines.
 */
function syncTextFile(options: {
  desiredContent: string | null;
  filePath: string;
  label: string;
  mode: AgentsGuidanceMode;
  report: AgentsGuidanceTargetReport;
}): void {
  const existingContent = readOptionalFile(options.filePath);
  const isUnchanged = compareTextFileContent(existingContent, options.desiredContent);

  if (isUnchanged) {
    return;
  }

  options.report.driftDetected += 1;
  if (options.mode === "check") {
    options.report.changes.push(`[drift] ${options.label}`);
    return;
  }

  if (options.mode === "dry-run") {
    options.report.changes.push(
      `${options.desiredContent === null ? "delete" : "write"} ${options.label}`,
    );
    return;
  }

  if (options.desiredContent === null) {
    if (fs.existsSync(options.filePath)) {
      fs.rmSync(options.filePath, { force: true });
    }
    options.report.changes.push(`deleted ${options.label}`);
    return;
  }

  fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
  fs.writeFileSync(options.filePath, options.desiredContent, "utf8");
  options.report.changes.push(`wrote ${options.label}`);
}

/**
 * Runs Codex agents-guidance generation and config wiring under the requested sync mode.
 *
 * @remarks
 * I/O: loads `AGENTS.md` and optional `CODEX.md`, reads `.codex/config.toml`, and delegates writes
 * to `syncTextFile` when mode is `"write"`.
 * Suppressed Codex delta yields deletion of generated guidance and config cleanup via null payloads.
 * Fatal failures append to `report.errors` without throwing past the harness boundary.
 *
 * @param options.mode - Check, dry-run, or write semantics for downstream file sync.
 * @param options.repoRoot - Repository root resolving all harness-relative paths.
 * @returns Per-target report summarizing drift, planned or applied changes, and errors.
 */
function syncCodexTarget(options: {
  mode: AgentsGuidanceMode;
  repoRoot: string;
}): AgentsGuidanceTargetReport {
  const report: AgentsGuidanceTargetReport = {
    changes: [],
    driftDetected: 0,
    errors: [],
    targetId: "codex",
  };

  try {
    const target = getTargetDefinition("codex");
    const agentsFilePath = path.join(options.repoRoot, ROOT_GUIDANCE_FILE_NAME);
    const codexSourceFilePath = path.join(options.repoRoot, target.authoredDeltaFileName);
    const generatedGuidanceFilePath = path.join(options.repoRoot, target.generatedFileName);
    const codexConfigFilePath = path.join(options.repoRoot, CODEX_CONFIG_FILE_NAME);
    const agentsContent = readRequiredFile(agentsFilePath);
    const codexContent = readOptionalFile(codexSourceFilePath);
    const trimmedCodexContent = codexContent === null ? "" : trimTrailingBlankLines(codexContent);
    const desiredGeneratedGuidanceContent = trimmedCodexContent.length > 0
      ? buildCodexGuidanceContent({
          agentsContent,
          codexContent: codexContent ?? "",
        })
      : null;

    syncTextFile({
      desiredContent: desiredGeneratedGuidanceContent,
      filePath: generatedGuidanceFilePath,
      label: target.generatedFileName,
      mode: options.mode,
      report,
    });

    const rawCodexConfigContent = readOptionalFile(codexConfigFilePath) ?? "";
    const desiredCodexConfigContent = updateCodexConfigContent({
      guidanceFilePath:
        desiredGeneratedGuidanceContent === null
          ? null
          : path.resolve(generatedGuidanceFilePath),
      rawConfigContent: rawCodexConfigContent,
    });

    syncTextFile({
      desiredContent: desiredCodexConfigContent.length > 0 ? desiredCodexConfigContent : null,
      filePath: codexConfigFilePath,
      label: CODEX_CONFIG_FILE_NAME,
      mode: options.mode,
      report,
    });
  } catch (error: unknown) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }

  return report;
}

/**
 * Splits and validates comma-separated agents-guidance harness identifiers.
 *
 * @remarks
 * PURITY: string parsing only; every token must exist in `AGENTS_GUIDANCE_TARGETS`.
 *
 * @param value - Raw comma-separated list from CLI `--target` parsing (already trimmed per token).
 * @returns Ordered ids matching the caller’s token sequence before deduplication upstream.
 * @throws Error when a non-empty token is not registered in `AGENTS_GUIDANCE_TARGETS`.
 */
function parseTargetList(value: string): AgentsGuidanceTargetId[] {
  const targetIds = value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return targetIds.map((token) => {
    if (!AGENTS_GUIDANCE_TARGETS.some((target) => target.id === token)) {
      throw new Error(`Unsupported agents-guidance target: ${token}`);
    }

    return token as AgentsGuidanceTargetId;
  });
}

/**
 * Parses `--target` and `--target=` CLI arguments into validated `AgentsGuidanceTargetId` values.
 *
 * @remarks
 * When no explicit targets are provided, defaults to all registered targets.
 * Duplicate targets are deduplicated in the returned array.
 * Throws on empty `--target` values or unsupported target identifiers.
 *
 * @param argv - Raw CLI argument array (typically `process.argv.slice(2)`).
 * @returns Deduplicated list of validated target identifiers.
 * @throws Error when `--target` is missing its value or an identifier is unsupported.
 */
export function parseAgentsGuidanceTargetIds(argv: string[]): AgentsGuidanceTargetId[] {
  const explicitTargets: AgentsGuidanceTargetId[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      const nextValue = argv[index + 1] ?? "";
      if (nextValue.length === 0) {
        throw new Error("Missing value for --target.");
      }
      explicitTargets.push(...parseTargetList(nextValue));
      index += 1;
      continue;
    }

    if (argument.startsWith("--target=")) {
      explicitTargets.push(...parseTargetList(argument.slice("--target=".length)));
    }
  }

  return explicitTargets.length > 0
    ? [...new Set(explicitTargets)]
    : AGENTS_GUIDANCE_TARGETS.map((target) => target.id);
}

/**
 * Orchestrates agents-guidance sync for the requested targets across check, dry-run, and write modes.
 *
 * @remarks
 * I/O: reads `AGENTS.md` and target delta files from disk; writes generated guidance and
 * `.codex/config.toml` only in write mode.
 * Each target produces an independent `AgentsGuidanceTargetReport` with per-file change lists,
 * drift counts, and fatal errors.
 *
 * @param options.mode - `"check"` reports drift, `"dry-run"` previews actions, `"write"` applies changes.
 * @param options.repoRoot - Repository root used to resolve source and generated file paths.
 * @param options.targetIds - Target harnesses to sync; currently only `"codex"` is supported.
 * @returns Aggregate report summing changes, drift, and errors across all requested targets.
 */
export function syncAgentsGuidance(options: {
  mode: AgentsGuidanceMode;
  repoRoot: string;
  targetIds: readonly AgentsGuidanceTargetId[];
}): AgentsGuidanceReport {
  const targetReports = options.targetIds.map((targetId) => {
    if (targetId === "codex") {
      return syncCodexTarget({
        mode: options.mode,
        repoRoot: options.repoRoot,
      });
    }

    return {
      changes: [],
      driftDetected: 0,
      errors: [`Unsupported agents-guidance target: ${targetId}`],
      targetId,
    } satisfies AgentsGuidanceTargetReport;
  });

  return {
    targets: targetReports,
    totalChanges: targetReports.reduce((total, report) => total + report.changes.length, 0),
    totalDriftDetected: targetReports.reduce(
      (total, report) => total + report.driftDetected,
      0,
    ),
    totalErrors: targetReports.reduce((total, report) => total + report.errors.length, 0),
  };
}
