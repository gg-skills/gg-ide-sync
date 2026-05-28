/**
 * @fileoverview Generates `npm-run-*` IDE workflow shortcuts from root `package.json` scripts.
 *
 * Flow: read `package.json` scripts -> synthesize workflow markdown bodies -> sync to targets with prefix-scoped clears (never writes into canonical `canonical-workflows/`).
 *
 * @example
 * // CLI usage
 * npx tsx scripts/canonical-workflows/sync-npm.ts        # dry-run
 * npx tsx scripts/canonical-workflows/sync-npm.ts --write # apply
 *
 * @testing CLI manual: run `npx tsx scripts/canonical-workflows/sync-npm.ts` from the repo root (optional `--write`).
 * @see scripts/canonical-workflows/targets.ts - Shared workflow target routing helpers.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDefaultTargetConfigs,
  type Command,
  NPM_WORKFLOW_PREFIX,
  syncCommandsToTargets,
} from "./targets";

const PACKAGE_JSON = "package.json";

/**
 * Verbose toggle. Set `WORKFLOWS_SYNC_VERBOSE=1` (or legacy `SYNC_VERBOSE=1`) to
 * restore setup chatter — "Searching for...", "Found N npm scripts", etc.
 * Errors and warnings are NEVER gated.
 */
const VERBOSE_LOG =
  process.env.WORKFLOWS_SYNC_VERBOSE === "1" ||
  process.env.SYNC_VERBOSE === "1";

/**
 * Writes a prefixed line to stdout, stderr warnings, or stderr errors for this CLI.
 *
 * @remarks
 * I/O: uses Node `console` APIs; `"info"` participates in upstream verbose gating only when routed
 * through `vlog`, while `"warn"` and `"error"` always surface immediately.
 *
 * @param message - Human-readable diagnostic line without the script prefix (added here).
 * @param type - Selects severity channel; callers use `"warn"`/`"error"` for operator-visible faults.
 */
function log(message: string, type: "info" | "warn" | "error" = "info"): void {
  const prefix = "[sync-workflows-npm]";

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
 * Returns whether `filePath` currently exists according to synchronous filesystem probing.
 *
 * @remarks
 * I/O: `fs.existsSync` with errors logged and treated as non-existent for forward progress.
 *
 * @param filePath - Candidate path (typically absolute or anchored to process cwd callers).
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
 * Reads UTF-8 JSON from disk into a parsed plain object envelope.
 *
 * @remarks
 * I/O: synchronous read; rejects arrays/`null`/primitives before returning; logs failures as
 * `"error"` and yields `null` so callers halt orchestration cleanly.
 *
 * @param filePath - JSON document path expected to contain an object payload.
 */
function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      log(`Invalid JSON object in ${filePath}`, "error");
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Error reading JSON file ${filePath}: ${msg}`, "error");
    return null;
  }
}

/**
 * Produces dashed workflow-safe tokens from npm script keys that commonly use colon namespaces.
 *
 * @param scriptName - `package.json` scripts map key unchanged except for delimiter normalization.
 */
function normalizeScriptName(scriptName: string): string {
  return scriptName.replace(/:/g, "-");
}

/**
 * Returns a generated warning section for npm scripts that mutate host, runtime, or generated
 * local state.
 *
 * @remarks
 * The shortcuts intentionally mirror package.json command bodies. This section adds operator
 * guardrails without changing the command that gets run. Keep dry-run alternatives explicit when
 * the public npm alias is intentionally mutating for compatibility.
 *
 * @param scriptName - Root package.json script name.
 */
export function buildNpmWorkflowSafetyNotice(scriptName: string): string {
  const hostMutationNotices: Record<string, string> = {
    "local:edge:split-dns:apply": [
      "Host mutation: starts/restarts local dnsmasq and writes the macOS resolver file.",
      "Dry-run first: `bash ./scripts/local-edge/split-dns-apply.sh`.",
    ].join("\n"),
    "local:edge:split-dns:reset": [
      "Host mutation: stops the local dnsmasq listener and clears the macOS resolver file.",
      "Dry-run first: `bash ./scripts/local-edge/split-dns-reset.sh`.",
    ].join("\n"),
    "local:edge:loopback:alias:apply": [
      "Host mutation: runs `sudo ifconfig lo0 alias ...` for non-default loopback hosts.",
      "Dry-run first: `npm run local:edge:loopback:alias`.",
    ].join("\n"),
    "local:edge:tls:trust": [
      "Host trust-store mutation: runs `mkcert -install`.",
      "Dry-run first: `bash ./scripts/local-edge/tls-trust.sh --dry-run`.",
    ].join("\n"),
    "local:edge:tailscale:apply": [
      "Host/Tailscale mutation: applies `tailscale serve` mappings.",
      "Dry-run first: `bash ./scripts/local-edge/tailscale-apply-services.sh`.",
    ].join("\n"),
    "local:edge:tailscale:reset": [
      "Host/Tailscale mutation: clears `tailscale serve` mappings.",
      "Dry-run first: `bash ./scripts/local-edge/tailscale-reset-services.sh`.",
    ].join("\n"),
  };

  const runtimeMutationPatterns = [
    /^local$/,
    /^local:edge:raw$/,
    /^local:edge:init$/,
    /^local:edge:start(?::|$)/,
    /^local:edge:setup(?::|$)/,
    /^local:edge:ensure-running(?::|$)/,
    /^local:edge:router:start$/,
  ];
  const runtimeStopPatterns = [
    /^local:stop$/,
    /^local:kill$/,
    /^local:edge:stop(?::|$)/,
    /^local:edge:router:stop$/,
  ];
  const artifactMutationPatterns = [
    /^local:edge:render$/,
    /^local:edge:validate:env$/,
    /^local:edge:healthcheck(?::|$)/,
    /^env:workspace(?::|$)/,
    /^env:materialize(?::|$)/,
  ];

  let notice = hostMutationNotices[scriptName] ?? "";

  if (
    notice.length === 0 &&
    runtimeMutationPatterns.some((pattern) => pattern.test(scriptName))
  ) {
    notice =
      "Runtime mutation: may start local-edge/router/app processes, write runtime artifacts, or run setup checks.";
  }

  if (
    notice.length === 0 &&
    runtimeStopPatterns.some((pattern) => pattern.test(scriptName))
  ) {
    notice =
      "Runtime mutation: stops local-edge/router/app processes for the current checkout or shared router.";
  }

  if (
    notice.length === 0 &&
    artifactMutationPatterns.some((pattern) => pattern.test(scriptName))
  ) {
    notice =
      "Filesystem mutation: may write managed env, healthcheck, validation, or render artifacts. Prefer check/dry-run flags when available.";
  }

  if (notice.length === 0) {
    return "";
  }

  return `\n## Safety Notice\n\n${notice}\n`;
}

/**
 * Resolves `./package.json` relative to `process.cwd()` when the file exists.
 *
 * @remarks
 * Uses `fileExists`; verbose diagnostics route through `vlog` (`WORKFLOWS_SYNC_VERBOSE`).
 */
function findPackageJson(): string | null {
  vlog("Searching for package.json...");

  const packageJsonPath = path.join(process.cwd(), PACKAGE_JSON);
  if (fileExists(packageJsonPath)) {
    vlog(`Found package.json at: ${packageJsonPath}`);
    return packageJsonPath;
  }

  log(`Could not find package.json at ${packageJsonPath}`, "warn");
  return null;
}

/**
 * Collects up to ten unique `grep` hits showcasing where an npm script is invoked in `source/`.
 *
 * @remarks
 * I/O: synchronous `grep -r` from the repository root bounded to TypeScript/JavaScript globs under
 * `source/`; empty output is tolerated silently.
 *
 * @param scriptName - Target npm script name as referenced by `npm run <name>`.
 */
function findCommandReferences(scriptName: string): string[] {
  const searchPatterns = [
    `npm run ${scriptName}`,
    `npm run ${scriptName.replace(/:/g, "\\:")}`,
  ];
  const references: string[] = [];
  const extensions = ["*.ts", "*.js", "*.mjs"];
  const projectRoot = process.cwd();

  for (const pattern of searchPatterns) {
    try {
      const grepCommand = `grep -r -n --include=${extensions.join(" --include=")} "${pattern}" source/ || true`;
      const output = execSync(grepCommand, {
        encoding: "utf8",
        cwd: projectRoot,
      });

      if (output.trim()) {
        references.push(...output.trim().split("\n").filter(Boolean));
      }
    } catch {
      // No matches is fine.
    }
  }

  const uniqueRefs = [...new Set(references)].slice(0, 10);
  if (uniqueRefs.length > 0) {
    vlog(`Found ${uniqueRefs.length} references for ${scriptName}`);
  }
  return uniqueRefs;
}

/**
 * Builds one IDE workflow markdown definition plus descriptive metadata for a single npm script.
 *
 * @remarks
 * Embed optional reference bullets from `findCommandReferences`; truncates mirrored command previews
 * over 60 characters to keep UX copy skim-friendly inside generated markdown bodies.
 *
 * @param scriptName - npm script identifier used in headings and fenced bash sections.
 * @param packageCommand - Literal command body from package.json scripts map.
 * @param includeReferences - When false, omits References section entirely (typically dry-run/fast).
 */
export function buildNpmWorkflowCommand(
  scriptName: string,
  packageCommand: string,
  includeReferences = true,
): Command {
  const normalizedName = normalizeScriptName(scriptName);
  const workflowName = `${NPM_WORKFLOW_PREFIX}${normalizedName}`;
  const references = includeReferences ? findCommandReferences(scriptName) : [];
  const referenceLines = references
    .map((reference) => "- " + reference)
    .join("\n");
  const referencesSection =
    references.length > 0 ? "\n\n## References\n\n" + referenceLines : "";
  const safetyNotice = buildNpmWorkflowSafetyNotice(scriptName);

  const shortCommand =
    packageCommand.length > 60
      ? packageCommand.slice(0, 57).trimEnd() + "..."
      : packageCommand;

  const workflowContent = `---
description: Run ${scriptName} npm script
auto_execution_mode: 1
---

\`\`\`mermaid
flowchart TD
  A([BEGIN]) --> B["Receive user context"]
  B --> C["Run npm run ${scriptName}"]
  C --> D["${shortCommand}"]
  D --> E["Capture output"]
  E --> F["Report results"]
  F --> G([END])
\`\`\`

I want you to run this script:

\`\`\`bash
npm run ${scriptName}
\`\`\`${safetyNotice}

## What the script does

\`\`\`json
${packageCommand}
\`\`\`${referencesSection}

## Script Details

**Type:** npm script
**Name:** ${scriptName}
**Command:** npm run ${scriptName}


# Additional user context (if any)
\`\`\`
$ARGUMENTS
\`\`\`

`;
  return {
    name: workflowName,
    description: `Run ${scriptName} npm script`,
    source: "npm script",
    workflowContent,
  };
}

/**
 * Walks npm script entries into generated workflow commands while excluding sync bootstrap scripts.
 *
 * @remarks
 * Any script containing `sync-workflows` substring increments `skippedCount` and emits a warn log
 * to avoid recursive workflow sync definitions.
 *
 * @param scripts - npm `scripts` map after JSON parsing coercion.
 * @param includeReferences - Forwarded through to builders; aligns with `--write` reference scans.
 */
function collectNpmWorkflowCommands(
  scripts: Record<string, string>,
  includeReferences = true,
): { commands: Command[]; skippedCount: number } {
  const commands: Command[] = [];
  let skippedCount = 0;

  for (const [scriptName, packageCommand] of Object.entries(scripts)) {
    if (scriptName.includes("sync-workflows")) {
      skippedCount += 1;
      log(`Skipping sync-workflows script: ${scriptName}`, "warn");
      continue;
    }

    commands.push(
      buildNpmWorkflowCommand(scriptName, packageCommand, includeReferences),
    );
  }

  return {
    commands,
    skippedCount,
  };
}

/**
 * Orchestrates reading package scripts and syncing synthesized npm-run workflows across IDE targets.
 *
 * @remarks
 * I/O: reads `{cwd}/package.json`, then delegates writes to `syncCommandsToTargets` with prefix
 * clears; reference discovery only runs when not `dryRun` so dry runs stay fast.
 *
 * @param dryRun - When true, skips mutating targets and suppresses expensive reference searches.
 */
function syncNpmWorkflows(dryRun: boolean): boolean {
  vlog("Starting npm workflow generation...");

  if (dryRun) {
    vlog("DRY RUN MODE - No files will be modified (use --write to apply)");
  }

  const packageJsonPath = findPackageJson();
  if (!packageJsonPath) {
    log("Cannot proceed: missing package.json", "error");
    return false;
  }

  const packageJson = readJsonFile(packageJsonPath);
  const scripts = (packageJson?.scripts as Record<string, string>) ?? {};
  const { commands, skippedCount } = collectNpmWorkflowCommands(
    scripts,
    !dryRun,
  );
  const targets = buildDefaultTargetConfigs(process.cwd());

  vlog(`Found ${Object.keys(scripts).length} npm scripts`);
  vlog(`Prepared ${commands.length} generated npm workflow shortcuts`);
  if (skippedCount > 0) {
    vlog(`Skipped ${skippedCount} sync-workflows scripts`);
  }

  if (commands.length === 0) {
    log("No npm workflow shortcuts were generated", "error");
    return false;
  }

  const result = syncCommandsToTargets({
    commands,
    targets,
    dryRun,
    clearStrategy: "prefixes",
    clearPrefixes: [NPM_WORKFLOW_PREFIX, "npm-run-"],
    log,
  });

  if (result.failedTargets > 0) {
    log(
      `${commands.length} commands × ${targets.length} targets — ${result.successTargets} ok, ${result.failedTargets} failed`,
      "error",
    );
    return false;
  }

  log(`${commands.length} commands × ${targets.length} targets — 0 errors`);
  return true;
}

const isDryRun = !process.argv.includes("--write");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncNpmWorkflows(isDryRun);
}
