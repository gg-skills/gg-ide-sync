/**
 * @fileoverview Docs-sync script that inventories AGENTS.md, README.md, and
 * docs/SCREAMING_CASE*.md files across the root workspace and submodules, then
 * generates per-scope documentation-map rule files in `.ide-rules/` and projects
 * them into `.cursor/rules/`, `.windsurf/rules/`, and `.agents/rules/`.
 *
 * Dry-run by default; pass `--write` to emit files. Operates on `process.cwd()`
 * as the repo root.
 *
 * @example
 * // Dry run (default) — preview what would be generated
 * npx tsx scripts/docs-sync/sync-rules-documentation-map.ts
 *
 * // Emit all documentation-map rule files
 * npx tsx scripts/docs-sync/sync-rules-documentation-map.ts --write
 *
 * @testing CLI manual: run dry-run and --write variants from repo root and inspect `.ide-rules/`, `.cursor/rules/`, `.windsurf/rules/`, and `.agents/rules/` for `documentation-map--*` files.
 *
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - Canonical file-overview tag order and prose rules.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_JSDOC.md - Symbol-level JSDoc standards for exported functions.
 *
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import path from "node:path";

import { PlatformSubmoduleAutomation_listConfiguredSubmodulePaths } from "../platform/lib/submodule-automation";

/** Which documentation-map bucket a markdown path belongs to after classification. */
type FileKind = "agents" | "readme" | "docs";

/** Root or submodule boundary used when scanning files and titling generated rule maps. */
type RepoScope = {
  id: string;
  title: string;
  relativePath: string;
  summaryDescription: string;
};

/** One inventoried markdown file with repo context and extracted one-line summary. */
type DocumentationEntry = {
  kind: FileKind;
  repoId: string;
  repoTitle: string;
  platformPath: string;
  summary: string;
};

/** Aggregated index for one logical documentation-map rule (platform or scoped submodule). */
type LogicalMap = {
  id: string;
  title: string;
  description: string;
  coverage: string[];
  entries: DocumentationEntry[];
};

/** IDE-facing output sink: filesystem directory, file extension, and rule body renderer. */
type RuleTarget = {
  directory: string;
  extension: string;
  name: string;
  render: (document: RuleDocument) => string;
};

/** Neutral markdown body and front matter inputs shared across Cursor and mirror renderers. */
type RuleDocument = {
  fileNameBase: string;
  title: string;
  description: string;
  neutralBody: string;
};

const GENERATED_RULE_PREFIX = "documentation-map--";
const IDE_RULES_DIR = ".ide-rules";
const CURSOR_RULES_DIR = ".cursor/rules";
const WINDSURF_RULES_DIR = ".windsurf/rules";
const AGENTS_RULES_DIR = ".agents/rules";

const ROOT_REPO_SCOPE: RepoScope = {
  id: "repository-root",
  title: "Repository Root",
  relativePath: ".",
  summaryDescription: "repository-wide guidance and orchestration references",
};

const IGNORED_DIRECTORY_NAMES = new Set([
  ".agents",
  ".claude",
  ".cursor",
  ".git",
  ".idea",
  ".ide-rules",
  ".next",
  ".plans",
  ".private-env-notes",
  ".researches",
  ".studies",
  ".tmp",
  ".windsurf",
  "build",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "out",
  "tmp",
]);


/**
 * Normalizes a submodule-relative path into a stable lowercase slug for documentation-map rule ids.
 *
 * @remarks
 * Collapses non-alphanumeric runs to single hyphens, trims leading and trailing hyphens, and uses
 * the literal fallback `submodule` when the result would otherwise be empty.
 */
function slugifyScopeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "submodule";
}

/**
 * Resolves a human-facing title for a scope by reading `package.json` when present.
 *
 * @remarks
 * I/O: synchronous read of `package.json` under the scope path; returns `relativePath` when the
 * file is missing, unparsable, or lacks a non-empty string `name`.
 */
function readPackageDisplayName(repoRoot: string, relativePath: string): string {
  const packageJsonPath = path.join(repoRoot, relativePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return relativePath;
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const name = (parsed as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim().length > 0) {
        return name.trim();
      }
    }
  } catch {
    return relativePath;
  }

  return relativePath;
}

/**
 * Builds the platform-root scope plus one scope per configured git submodule for inventory passes.
 *
 * @remarks
 * Submodule ids come from `slugifyScopeId` on the configured relative path; titles prefer
 * `readPackageDisplayName`. Ordering is root first, then submodules as returned by the platform
 * submodule list helper.
 */
function buildRepoScopes(repoRoot: string): RepoScope[] {
  const submoduleScopes = PlatformSubmoduleAutomation_listConfiguredSubmodulePaths(repoRoot).map((relativePath) => ({
    id: slugifyScopeId(relativePath),
    title: readPackageDisplayName(repoRoot, relativePath),
    relativePath,
    summaryDescription: `submodule documentation under ${relativePath}`,
  }));

  return [ROOT_REPO_SCOPE, ...submoduleScopes];
}

const VERBOSE =
  process.env.SYNC_VERBOSE === "1" ||
  process.env.WORKFLOWS_SYNC_VERBOSE === "1";

/**
 * Writes a prefixed sync log line at the requested severity channel.
 *
 * @remarks
 * I/O: stdout for info, stderr for errors, console.warn for warnings.
 */
function log(message: string, type: "info" | "warn" | "error" = "info"): void {
  const prefix = "[rules:sync:documentation-map]";
  const timestamp = new Date().toISOString();
  const line = `${prefix} [${type.toUpperCase()}] ${timestamp} - ${message}`;

  if (type === "error") {
    console.error(line);
    return;
  }

  if (type === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

/** Emits detailed scan and write diagnostics only when verbose env toggles are on. */
function logVerbose(message: string): void {
  if (VERBOSE) {
    log(message);
  }
}

/**
 * Normalizes path separators so generated maps and ignores compare consistently cross-platform.
 */
function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * Ensures an output directory exists before writing documentation-map artifacts.
 *
 * @remarks
 * I/O: synchronous mkdir when missing; logs directory creation at info severity.
 */
function ensureDirectoryExists(directoryPath: string): void {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
    log(`Created directory: ${directoryPath}`);
  }
}

/** Collapses internal whitespace when extracting front matter or heading summaries. */
function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Detects `docs/` markdown files whose basenames match the SCREAMING_CASE inventory contract.
 *
 * @remarks
 * Requires a `/docs/` path segment anchored at the repo-relative root or after a slash.
 */
function isScreamingCaseDocumentationFile(relativePath: string): boolean {
  const normalizedPath = toPosixPath(relativePath);
  const docsSegment = "docs/";
  const docsIndex = normalizedPath.indexOf(docsSegment);

  if (docsIndex === -1) {
    return false;
  }

  if (docsIndex !== 0 && normalizedPath[docsIndex - 1] !== "/") {
    return false;
  }

  const basename = path.posix.basename(normalizedPath);
  return /^[A-Z0-9][A-Z0-9_-]*\.md$/.test(basename);
}

/** Maps relative markdown paths into documentation-map buckets, or rejects unknown names. */
function classifyFile(relativePath: string): FileKind | null {
  const basename = path.basename(relativePath);

  if (basename === "AGENTS.md") {
    return "agents";
  }

  if (basename === "README.md") {
    return "readme";
  }

  if (isScreamingCaseDocumentationFile(relativePath)) {
    return "docs";
  }

  return null;
}

/**
 * Extract a one-line summary from markdown content using a fallback cascade:
 * frontmatter `description`, then first `#` or `##` heading, then first
 * non-empty body line.
 */
function extractSummary(content: string): string {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const descriptionMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
    if (descriptionMatch) {
      const description = normalizeInlineText(
        descriptionMatch[1].replace(/(^["'])|(["']$)/g, ""),
      );
      if (description.length > 0) {
        return description;
      }
    }
  }

  const headingMatch = content.match(/^#{1,2}\s+(.+)$/m);
  if (headingMatch) {
    const heading = normalizeInlineText(headingMatch[1]);
    if (heading.length > 0) {
      return heading;
    }
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (
      trimmedLine.length > 0 &&
      !trimmedLine.startsWith("#") &&
      !trimmedLine.startsWith("---") &&
      !trimmedLine.startsWith("```")
    ) {
      return normalizeInlineText(trimmedLine);
    }
  }

  return "No summary available.";
}

/**
 * Depth-first traversal of a scope directory that collects qualifying markdown inventories.
 *
 * @remarks
 * I/O: synchronous directory reads and full-file reads into memory; skips ignored dirs and scoped
 * submodule roots under platform-root.
 */
function walkScopeEntries(
  repoRoot: string,
  currentDirectory: string,
  scope: RepoScope,
  entries: DocumentationEntry[],
): void {
  const directoryEntries = fs.readdirSync(currentDirectory, { withFileTypes: true });

  for (const directoryEntry of directoryEntries) {
    const absolutePath = path.join(currentDirectory, directoryEntry.name);
    const relativePath = path.relative(repoRoot, absolutePath);
    const relativePathPosix = toPosixPath(relativePath);

    if (directoryEntry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(directoryEntry.name)) {
        continue;
      }


      walkScopeEntries(repoRoot, absolutePath, scope, entries);
      continue;
    }

    if (!directoryEntry.isFile() || !directoryEntry.name.endsWith(".md")) {
      continue;
    }

    const kind = classifyFile(relativePathPosix);
    if (!kind) {
      continue;
    }

    const platformPath =
      scope.relativePath === "."
        ? relativePathPosix
        : `${scope.relativePath}/${relativePathPosix}`;
    const content = fs.readFileSync(absolutePath, "utf8");

    entries.push({
      kind,
      repoId: scope.id,
      repoTitle: scope.title,
      platformPath,
      summary: extractSummary(content),
    });
  }
}

/**
 * Builds sorted documentation entries for one repo scope or returns empty when the root is missing.
 *
 * @remarks
 * I/O: walks the scope filesystem tree; warns when scope root paths are absent on disk.
 */
function collectScopeEntries(repoRoot: string, scope: RepoScope): DocumentationEntry[] {
  const scopeRoot =
    scope.relativePath === "." ? repoRoot : path.join(repoRoot, scope.relativePath);

  if (!fs.existsSync(scopeRoot)) {
    log(`Skipping missing scope root: ${scope.relativePath}`, "warn");
    return [];
  }

  const entries: DocumentationEntry[] = [];
  walkScopeEntries(scopeRoot, scopeRoot, scope, entries);
  entries.sort((left, right) => left.platformPath.localeCompare(right.platformPath));
  return entries;
}

/**
 * Renders one markdown subsection with either bullet entries or an explicit empty-state line.
 */
function buildSection(
  heading: string,
  entries: DocumentationEntry[],
  emptyMessage: string,
): string[] {
  const lines = [`## ${heading}`, ""];

  if (entries.length === 0) {
    lines.push(`- ${emptyMessage}`, "");
    return lines;
  }

  for (const entry of entries) {
    lines.push(`- \`${entry.platformPath}\` (${entry.repoTitle}) - ${entry.summary}`);
  }

  lines.push("");
  return lines;
}

/** Assembles the neutral markdown rule body spanning coverage and per-kind inventories. */
function buildNeutralBody(logicalMap: LogicalMap): string {
  const agentEntries = logicalMap.entries.filter((entry) => entry.kind === "agents");
  const readmeEntries = logicalMap.entries.filter((entry) => entry.kind === "readme");
  const docsEntries = logicalMap.entries.filter((entry) => entry.kind === "docs");

  const lines = [
    `# ${logicalMap.title}`,
    "",
    logicalMap.description,
    "",
    "Use this file as a generated index only. When a referenced path looks relevant, open the",
    "referenced file itself and treat that file as the source of truth.",
    "",
    "## Coverage",
    "",
    ...logicalMap.coverage.map((coverageItem) => `- ${coverageItem}`),
    "",
    ...buildSection("AGENTS.md Files", agentEntries, "No AGENTS.md files found in scope."),
    ...buildSection("README.md Files", readmeEntries, "No README.md files found in scope."),
    ...buildSection(
      "docs/SCREAMING_CASE*.md Files",
      docsEntries,
      "No docs/SCREAMING_CASE*.md files found in scope.",
    ),
  ];

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Build a documentation-map rule document for each repo scope plus a combined
 * platform-wide map.
 */
function buildLogicalMaps(repoRoot: string): RuleDocument[] {
  const repoScopes = buildRepoScopes(repoRoot);
  const rootSubmoduleDirectoryNames = new Set(repoScopes.filter((scope) => scope.relativePath !== ".").map((scope) => scope.relativePath));
  const activeScopes = repoScopes.filter((scope) => {
    const scopeRoot = scope.relativePath === "." ? repoRoot : path.join(repoRoot, scope.relativePath);
    return fs.existsSync(scopeRoot);
  });

  const scopeEntries = new Map<string, DocumentationEntry[]>();
  for (const scope of activeScopes) {
    scopeEntries.set(scope.id, collectScopeEntries(repoRoot, scope));
  }

  const platformRootEntries = (scopeEntries.get("repository-root") ?? []).filter(
    (entry) =>
      !Array.from(rootSubmoduleDirectoryNames).some((directoryName) =>
        entry.platformPath.startsWith(`${directoryName}/`),
      ),
  );
  const platformEntries = [
    ...platformRootEntries,
    ...activeScopes
      .filter((scope) => scope.id !== "repository-root")
      .flatMap((scope) => scopeEntries.get(scope.id) ?? []),
  ];
  const logicalMaps: LogicalMap[] = [
    {
      id: "repository-root",
      title: "Documentation Map: Repository Root",
      description:
        "Repository-wide index of AGENTS.md, README.md, and docs/SCREAMING_CASE*.md files across the root workspace and configured submodules.",
      coverage: activeScopes.map((scope) =>
        scope.relativePath === "."
          ? "Repository root workspace"
          : `${scope.relativePath} (${scope.summaryDescription})`,
      ),
      entries: platformEntries,
    },
    ...activeScopes
      .filter((scope) => scope.id !== "repository-root")
      .map((scope) => ({
        id: scope.id,
        title: `Documentation Map: ${scope.title}`,
        description: `Scoped index of AGENTS.md, README.md, and docs/SCREAMING_CASE*.md files for ${scope.title}.`,
        coverage: [`${scope.relativePath} (${scope.summaryDescription})`],
        entries: scopeEntries.get(scope.id) ?? [],
      })),
  ];

  return logicalMaps.map((logicalMap) => ({
    fileNameBase: `${GENERATED_RULE_PREFIX}${logicalMap.id}`,
    title: logicalMap.title,
    description: logicalMap.description,
    neutralBody: buildNeutralBody(logicalMap),
  }));
}

/**
 * Deletes generated documentation-map artifacts in a directory that are not in the expected set.
 *
 * @remarks
 * I/O: synchronous unlink of stale owned files only; skips `.gitkeep` and unrelated filenames.
 *
 * @returns Count of removed files for logging.
 */
function clearStaleOwnedFiles(
  directoryPath: string,
  expectedFilenames: Set<string>,
): number {
  if (!fs.existsSync(directoryPath)) {
    return 0;
  }
  let removedCount = 0;
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === ".gitkeep" || !entry.name.startsWith(GENERATED_RULE_PREFIX)) {
      continue;
    }
    if (expectedFilenames.has(entry.name)) {
      continue;
    }
    fs.unlinkSync(path.join(directoryPath, entry.name));
    removedCount += 1;
  }
  return removedCount;
}

/** Wraps neutral body with Cursor markdown rule front matter (YAML with description + alwaysApply). */
function renderCursorRule(document: RuleDocument): string {
  return [
    "---",
    `description: ${JSON.stringify(document.description)}`,
    "alwaysApply: false",
    "---",
    "",
    document.neutralBody.trimEnd(),
    "",
  ].join("\n");
}

/**
 * Wraps neutral body with Windsurf and Antigravity mirror front matter (`trigger: model_decision`).
 */
function renderMirrorRule(document: RuleDocument): string {
  return [
    "---",
    "trigger: model_decision",
    `description: ${JSON.stringify(document.description)}`,
    "---",
    "",
    document.neutralBody.trimEnd(),
    "",
  ].join("\n");
}

/** Resolves Cursor, Windsurf, and Agent rule directories anchored at the repo root. */
function buildRuleTargets(repoRoot: string): RuleTarget[] {
  return [
    {
      name: "Cursor",
      directory: path.join(repoRoot, CURSOR_RULES_DIR),
      extension: ".mdc",
      render: renderCursorRule,
    },
    {
      name: "Windsurf",
      directory: path.join(repoRoot, WINDSURF_RULES_DIR),
      extension: ".md",
      render: renderMirrorRule,
    },
    {
      name: "Antigravity Agent",
      directory: path.join(repoRoot, AGENTS_RULES_DIR),
      extension: ".md",
      render: renderMirrorRule,
    },
  ];
}

/**
 * Write neutral `.md` documentation-map files to `.ide-rules/` and remove
 * stale generated files that are no longer in the expected set.
 */
function writeNeutralDocuments(repoRoot: string, documents: RuleDocument[]): void {
  const neutralDirectory = path.join(repoRoot, IDE_RULES_DIR);
  ensureDirectoryExists(neutralDirectory);

  const expectedFilenames = new Set(
    documents.map((document) => `${document.fileNameBase}.md`),
  );
  const staleRemoved = clearStaleOwnedFiles(neutralDirectory, expectedFilenames);
  if (staleRemoved > 0) {
    log(
      `Removed ${staleRemoved} stale neutral documentation-map file(s) from ${IDE_RULES_DIR}`,
    );
  }

  let changedCount = 0;
  let createdCount = 0;
  for (const document of documents) {
    const outputPath = path.join(neutralDirectory, `${document.fileNameBase}.md`);
    const isExisting = fs.existsSync(outputPath);
    const priorContent = isExisting ? fs.readFileSync(outputPath, "utf8") : null;
    if (priorContent === document.neutralBody) {
      logVerbose(
        `neutral map: ${toPosixPath(path.relative(repoRoot, outputPath))} ✓ (up to date)`,
      );
      continue;
    }
    fs.writeFileSync(outputPath, document.neutralBody, "utf8");
    if (isExisting) {
      changedCount += 1;
      logVerbose(`Updated neutral map: ${toPosixPath(path.relative(repoRoot, outputPath))}`);
    } else {
      createdCount += 1;
      logVerbose(`Wrote neutral map: ${toPosixPath(path.relative(repoRoot, outputPath))}`);
    }
  }

  if (changedCount + createdCount === 0 && staleRemoved === 0) {
    log(`${IDE_RULES_DIR}: no changes (${documents.length} maps already up to date)`);
  } else {
    log(
      `${IDE_RULES_DIR}: ${documents.length} maps (created: ${createdCount}, updated: ${changedCount}, removed: ${staleRemoved})`,
    );
  }
}

/**
 * Project neutral documentation-map documents into each IDE-specific rule
 * directory (Cursor, Windsurf, Antigravity Agent) using the target's format.
 */
function writeTargetDocuments(repoRoot: string, documents: RuleDocument[]): void {
  const targets = buildRuleTargets(repoRoot);

  for (const target of targets) {
    ensureDirectoryExists(target.directory);

    const expectedFilenames = new Set(
      documents.map((document) => `${document.fileNameBase}${target.extension}`),
    );
    const staleRemoved = clearStaleOwnedFiles(target.directory, expectedFilenames);
    if (staleRemoved > 0) {
      log(
        `Removed ${staleRemoved} stale ${target.name} rule(s) from ${toPosixPath(path.relative(repoRoot, target.directory))}`,
      );
    }

    let changedCount = 0;
    let createdCount = 0;
    for (const document of documents) {
      const outputPath = path.join(target.directory, `${document.fileNameBase}${target.extension}`);
      const newContent = target.render(document);
      const isExisting = fs.existsSync(outputPath);
      const priorContent = isExisting
        ? fs.readFileSync(outputPath, "utf8")
        : null;
      if (priorContent === newContent) {
        logVerbose(
          `${target.name} rule: ${toPosixPath(path.relative(repoRoot, outputPath))} ✓ (up to date)`,
        );
        continue;
      }
      fs.writeFileSync(outputPath, newContent, "utf8");
      if (isExisting) {
        changedCount += 1;
        logVerbose(
          `Updated ${target.name} rule: ${toPosixPath(path.relative(repoRoot, outputPath))}`,
        );
      } else {
        createdCount += 1;
        logVerbose(
          `Wrote ${target.name} rule: ${toPosixPath(path.relative(repoRoot, outputPath))}`,
        );
      }
    }

    if (changedCount + createdCount === 0 && staleRemoved === 0) {
      log(`${target.name}: no changes (${documents.length} rules already up to date)`);
    } else {
      log(
        `${target.name}: ${documents.length} rules (created: ${createdCount}, updated: ${changedCount}, removed: ${staleRemoved})`,
      );
    }
  }
}

/**
 * Prints neutral and per-IDE planned output paths without mutating the filesystem (--write omitted).
 *
 * @remarks
 * I/O: logs only.
 */
function showDryRun(repoRoot: string, documents: RuleDocument[]): void {
  log("DRY RUN - documentation-map rule sync");
  log(`Neutral output directory: ${IDE_RULES_DIR}`);

  for (const document of documents) {
    log(`  - ${IDE_RULES_DIR}/${document.fileNameBase}.md`);
  }

  for (const target of buildRuleTargets(repoRoot)) {
    const targetRelativePath = toPosixPath(path.relative(repoRoot, target.directory));
    log(`Target: ${target.name} -> ${targetRelativePath}`);
    for (const document of documents) {
      log(`  - ${targetRelativePath}/${document.fileNameBase}${target.extension}`);
    }
  }
}

/**
 * Entrypoint. Runs in dry-run mode unless `--write` is passed.
 */
function main(): void {
  const repoRoot = process.cwd();
  const dryRun = !process.argv.includes("--write");
  const documents = buildLogicalMaps(repoRoot);

  if (documents.length === 0) {
    log("No documentation-map documents were generated.", "error");
    process.exitCode = 1;
    return;
  }

  logVerbose(`Prepared ${documents.length} logical documentation-map rule files.`);

  if (dryRun) {
    showDryRun(repoRoot, documents);
    return;
  }

  writeNeutralDocuments(repoRoot, documents);
  writeTargetDocuments(repoRoot, documents);
  logVerbose("Documentation-map rule sync complete.");
}

main();
