/**
 * @fileoverview Shared library for canonical agent parsing, discovery, merge, and multi-target
 * generation across the agentic toolchain.
 *
 * This module owns the core sync engine that transforms canonical agent markdown into
 * tool-native formats for Kilo, Augment, pi, Kimi, Claude Code, and Codex.
 * Flow: discover canonical agents -> merge with overrides -> format per-tool -> sync output.
 *
 * @example
 * ```typescript
 * import { discoverCanonicalAgents, buildAgentTargets, syncAgents } from "./lib";
 *
 * const agents = discoverCanonicalAgents(
 *   "canonical-agents/primary-agents",
 *   "canonical-agents/subagents",
 * );
 * const targets = buildAgentTargets(process.cwd());
 * const result = syncAgents(agents, new Map(), targets, "dry-run", undefined, console.log);
 * console.log(result);
 * ```
 *
 * @testing Jest unit: NODE_OPTIONS='--experimental-vm-modules' npx jest --config jest.config.ts scripts/__tests__/sync-agents-lib.unit.test.ts
 *
 * @see skills/ide-sync/scripts/canonical-agents/generate.ts - CLI entrypoint that orchestrates discovery, target building, and sync via this library.
 * @see skills/ide-sync/scripts/__tests__/sync-agents-lib.unit.test.ts - Jest coverage for agent parsing, override merging, target formatting, and sync-engine drift detection.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - Standard document that defines the file-overview format used by this header.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed canonical agent markdown with merged frontmatter and body text. */
export type CanonicalAgent = {
  id: string;
  description: string;
  mode: "primary" | "subagent";
  tools?: string[];
  frontmatter: Record<string, unknown>;
  bodyOnly?: boolean;
  body: string;
  source: "agents" | "subagents";
};

/** Parsed slash-command definition from `canonical-agents/commands` with optional argument hint text. */
export type CanonicalCommand = {
  id: string;
  description: string;
  argumentHint?: string;
  body: string;
};

/** Per-tool YAML override keyed by agent id; optional body replaces canonical markdown when set. */
export type AgentOverride = {
  agentId: string;
  frontmatter: Record<string, unknown>;
  body?: string;
};

/** Guides whether semantic code search uses a provider tool or falls back to `rg`. */
export type SemanticCodeSearchGuidance =
  | {
      fallback: "rg";
      kind: "fallback";
    }
  | {
      fallback: "rg";
      guidanceLabel: string;
      kind: "provider";
      toolName: string;
    };

/** Context passed through the merge/format pipeline to apply tool-specific semantic-search guidance. */
export type AgentGenerationContext = {
  semanticCodeSearch: SemanticCodeSearchGuidance;
};

/** Formats a canonical agent (with optional override) into a tool-specific output string or Kimi dual-file output. */
export type AgentFormatter = (
  agent: CanonicalAgent,
  override: AgentOverride | undefined,
  context?: AgentGenerationContext,
) => string | KimiAgentOutput;

/** Kimi dual-file emission: generated `agent.yaml` fragment plus companion `system.md` body. */
export type KimiAgentOutput = {
  yaml: string;
  systemMd: string;
};

/** Target tool definition that drives per-tool agent generation output. */
export type AgentTarget = {
  toolId: string;
  name: string;
  outputDir: string;
  formatter: AgentFormatter;
  fileExtension: string;
  excludeAgents?: string[];
};

/** Structured logger compatible with the sync result reporting surface. */
export type LogFn = (message: string, type?: "info" | "warn" | "error") => void;

/** Aggregated sync result counts across all agents and targets. */
export type SyncResult = {
  generated: number;
  skipped: number;
  driftDetected: number;
  errors: number;
  /** Files written or rewritten because content changed (or file did not exist). */
  written: number;
  /** Files left untouched in write mode because content was already up to date. */
  unchanged: number;
};

/** Write-through, dry-run preview, or check-only drift detection for agent/command sync entrypoints. */
type CanonicalAgentsLib_SyncMode = "dry-run" | "write" | "check";

const codexSandboxModes = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
/** Closed union of Codex sandbox tokens emitted into generated agent TOML. */
type CodexSandboxMode = (typeof codexSandboxModes)[number];
const canonicalApprovalFlows = ["default", "plan"] as const;
/** Closed union of portable approval-flow tokens mapped onto Claude Code settings. */
type CanonicalApprovalFlow = (typeof canonicalApprovalFlows)[number];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Splits fenced YAML frontmatter from the markdown body for canonical agent/command files.
 *
 * @remarks
 * Returns null when the delimiter pair is absent, YAML does not yield a plain object, or the parsed
 * root is an array.
 */
function extractFrontmatter(
  content: string,
): { data: Record<string, unknown>; body: string } | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match || typeof match[1] !== "string") {
    return null;
  }
  const parsed = yaml.load(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return {
    data: parsed as Record<string, unknown>,
    body: content.slice(match[0].length),
  };
}

/** Parses a canonical agent markdown file, extracting YAML frontmatter and trimmed body. Throws if frontmatter is absent or invalid. */
export function parseCanonicalAgent(
  filePath: string,
  source: "agents" | "subagents",
): CanonicalAgent {
  const content = fs.readFileSync(filePath, "utf-8");
  const extracted = extractFrontmatter(content);
  if (!extracted) {
    throw new Error(`No valid frontmatter in ${filePath}`);
  }
  const { data, body } = extracted;
  const id = data.id as string;
  if (!id) {
    throw new Error(`Missing 'id' in frontmatter of ${filePath}`);
  }
  return {
    id,
    description: (data.description as string) ?? "",
    mode: (data.mode as "primary" | "subagent") ?? "primary",
    tools: data.tools as string[] | undefined,
    frontmatter: data,
    bodyOnly: data.bodyOnly as boolean | undefined,
    body: body.trim(),
    source,
  };
}

/** Parses a tool-specific override file. Returns an override with empty frontmatter if none is found. */
export function parseOverride(filePath: string): AgentOverride {
  const content = fs.readFileSync(filePath, "utf-8");
  const extracted = extractFrontmatter(content);
  if (!extracted) {
    // Override with empty frontmatter — just a body replacement
    return {
      agentId: path.basename(filePath, ".md"),
      frontmatter: {},
      body: content.trim() || undefined,
    };
  }
  const { data, body } = extracted;
  const agentId = path.basename(filePath, ".md");
  return {
    agentId,
    frontmatter: data,
    body: body.trim() || undefined,
  };
}

/** Parses a canonical command markdown file. Uses filename as id fallback when frontmatter id is absent. */
export function parseCanonicalCommand(filePath: string): CanonicalCommand {
  const content = fs.readFileSync(filePath, "utf-8");
  const extracted = extractFrontmatter(content);
  if (!extracted) {
    throw new Error(`No valid frontmatter in ${filePath}`);
  }
  const { data, body } = extracted;
  const id = (data.id as string) ?? path.basename(filePath, ".md");
  return {
    id,
    description: (data.description as string) ?? "",
    argumentHint: data["argument-hint"] as string | undefined,
    body: body.trim(),
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Discovers all canonical agent markdown files in the top-level of agentsDir and subagentsDir. */
export function discoverCanonicalAgents(
  agentsDir: string,
  subagentsDir: string,
): CanonicalAgent[] {
  const agents: CanonicalAgent[] = [];
  for (const dir of [
    { path: agentsDir, source: "agents" as const },
    { path: subagentsDir, source: "subagents" as const },
  ]) {
    if (!fs.existsSync(dir.path)) continue;
    for (const file of fs
      .readdirSync(dir.path)
      .filter((f) => f.endsWith(".md") && f !== ".gitkeep")) {
      agents.push(parseCanonicalAgent(path.join(dir.path, file), dir.source));
    }
  }
  return agents;
}

/** Returns a Map<toolId, Map<agentId, Override>> by traversing tool-specific subdirectories. */
export function discoverOverrides(
  overridesDir: string,
): Map<string, Map<string, AgentOverride>> {
  // Returns Map<toolId, Map<agentId, Override>>
  const result = new Map<string, Map<string, AgentOverride>>();
  if (!fs.existsSync(overridesDir)) return result;

  for (const toolDir of fs.readdirSync(overridesDir)) {
    const toolPath = path.join(overridesDir, toolDir);
    if (!fs.statSync(toolPath).isDirectory()) continue;
    const toolOverrides = new Map<string, AgentOverride>();
    for (const file of fs
      .readdirSync(toolPath)
      .filter((f) => f.endsWith(".md") && f !== ".gitkeep")) {
      const override = parseOverride(path.join(toolPath, file));
      toolOverrides.set(override.agentId, override);
    }
    result.set(toolDir, toolOverrides);
  }
  return result;
}

/** Returns all canonical command markdown files found in commandsDir. */
export function discoverCommands(commandsDir: string): CanonicalCommand[] {
  if (!fs.existsSync(commandsDir)) return [];
  return fs
    .readdirSync(commandsDir)
    .filter((f) => f.endsWith(".md") && f !== ".gitkeep")
    .map((f) => parseCanonicalCommand(path.join(commandsDir, f)));
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Deep-merges agent frontmatter with override, then applies semantic-code-search tool replacement if context is supplied. */
export function mergeAgentWithOverride(
  agent: CanonicalAgent,
  override: AgentOverride | undefined,
  context?: AgentGenerationContext,
): { frontmatter: Record<string, unknown>; body: string } {
  const canonicalFm = { ...agent.frontmatter };
  let mergedFm = canonicalFm;
  let mergedBody = agent.body;

  if (override) {
    mergedFm = deepMerge(canonicalFm, override.frontmatter);
    if (override.body) mergedBody = override.body;
  }

  if (context) {
    const semanticCodeSearchResult = applySemanticCodeSearchGuidance({
      body: mergedBody,
      semanticCodeSearch: context.semanticCodeSearch,
      tools: Array.isArray(mergedFm.tools)
        ? (mergedFm.tools as string[])
        : undefined,
    });

    mergedFm = {
      ...mergedFm,
      ...(semanticCodeSearchResult.tools
        ? { tools: semanticCodeSearchResult.tools }
        : {}),
    };
    if (!semanticCodeSearchResult.tools && "tools" in mergedFm) {
      delete mergedFm.tools;
    }
    mergedBody = semanticCodeSearchResult.body;
  }

  return { frontmatter: mergedFm, body: mergedBody };
}

/**
 * Builds per-target merged frontmatter by layering `targets.<toolId>` over shared keys.
 *
 * @remarks
 * Applies portable-default translation, drops cross-target-only keys (`access`, `approvalFlow`,
 * `reasoning`, `targets`), and returns a formatter-ready snapshot for that tool matrix cell.
 */
function resolveTargetFrontmatter(
  frontmatter: Record<string, unknown>,
  toolId: string,
): Record<string, unknown> {
  const targets =
    typeof frontmatter.targets === "object" &&
    frontmatter.targets !== null &&
    !Array.isArray(frontmatter.targets)
      ? (frontmatter.targets as Record<string, unknown>)
      : undefined;
  const targetFrontmatter =
    targets &&
    typeof targets[toolId] === "object" &&
    targets[toolId] !== null &&
    !Array.isArray(targets[toolId])
      ? (targets[toolId] as Record<string, unknown>)
      : {};

  const baseFrontmatter = { ...frontmatter };
  delete baseFrontmatter.targets;
  const resolved = deepMerge(baseFrontmatter, targetFrontmatter);

  applyPortableTargetDefaults(resolved, toolId);

  delete resolved.access;
  delete resolved.approvalFlow;
  delete resolved.reasoning;

  return resolved;
}

/**
 * Maps portable frontmatter knobs (`reasoning`, `access`, `approvalFlow`) onto tool-native keys.
 *
 * @remarks
 * Mutates `frontmatter` in place so downstream formatters read only normalized fields.
 */
function applyPortableTargetDefaults(
  frontmatter: Record<string, unknown>,
  toolId: string,
): void {
  if (frontmatter.reasoning !== undefined) {
    const reasoning = normalizePortableReasoning(frontmatter.reasoning);

    if (
      toolId === "codex" &&
      frontmatter.model_reasoning_effort === undefined
    ) {
      frontmatter.model_reasoning_effort = reasoning;
    }
    if (toolId === "claude-code" && frontmatter.effort === undefined) {
      frontmatter.effort = reasoning;
    }
    if (toolId === "pi" && frontmatter.thinking === undefined) {
      frontmatter.thinking = reasoning;
    }
  }

  if (
    frontmatter.access !== undefined &&
    toolId === "codex" &&
    frontmatter.sandbox_mode === undefined
  ) {
    frontmatter.sandbox_mode = normalizeCodexSandboxMode(
      frontmatter.access,
      (frontmatter.id as string) ?? "<unknown-agent>",
    );
  }

  if (
    frontmatter.approvalFlow !== undefined &&
    toolId === "claude-code" &&
    frontmatter.permissionMode === undefined
  ) {
    frontmatter.permissionMode = normalizeCanonicalApprovalFlow(
      frontmatter.approvalFlow,
    );
  }
}

/**
 * Validates the portable reasoning scalar sourced from YAML before propagating tool-specific knobs.
 *
 * @throws Error when the value is not a string.
 */
function normalizePortableReasoning(reasoning: unknown): string {
  if (typeof reasoning !== "string") {
    throw new Error(
      `Invalid reasoning value: expected string, received ${typeof reasoning}.`,
    );
  }

  return reasoning;
}

/**
 * Narrows YAML `approvalFlow` into Claude Code compatible permission presets.
 *
 * @throws Error when the value is not a string or not in the canonical approval-flow list.
 */
function normalizeCanonicalApprovalFlow(
  approvalFlow: unknown,
): CanonicalApprovalFlow {
  if (typeof approvalFlow !== "string") {
    throw new Error(
      `Invalid approvalFlow value: expected string, received ${typeof approvalFlow}.`,
    );
  }

  if ((canonicalApprovalFlows as readonly string[]).includes(approvalFlow)) {
    return approvalFlow as CanonicalApprovalFlow;
  }

  throw new Error(
    `Invalid approvalFlow value: "${approvalFlow}". Expected one of ${canonicalApprovalFlows.join(", ")}.`,
  );
}

/**
 * Deep-merges record-shaped frontmatter overlays while shallow-replacing leaves and arrays.
 *
 * @remarks
 * Recurses only when both sides hold non-null plain objects (arrays are atomic assignments).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      key in result &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof source[key] === "object" &&
      source[key] !== null &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Renders markdown guidance appended when semantic codebase search tooling is enabled.
 *
 * @remarks
 * Provider mode names the MCP tool substitute; fallback mode directs agents to rg/grep workflows.
 */
function buildSemanticCodeSearchBodyBlock(
  guidance: SemanticCodeSearchGuidance,
): string {
  if (guidance.kind === "provider") {
    return [
      "## Semantic Code Search",
      "",
      `- Prefer \`${guidance.toolName}\` for semantic codebase discovery on this workstation.`,
      "- Fall back to `grep`, `glob`, and direct file reads for exact matches or when semantic retrieval is unavailable.",
    ].join("\n");
  }

  return [
    "## Semantic Code Search",
    "",
    "- No semantic MCP is configured for this workstation.",
    "- Use `rg`, `grep`, `glob`, and direct file reads for code discovery.",
  ].join("\n");
}

/**
 * Applies semantic-code-search substitutions to merged body/tool lists ahead of formatter runs.
 *
 * @remarks
 * No-op unless `semantic-code-search` survives merging; swaps the MCP slot and augments prose.
 */
function applySemanticCodeSearchGuidance(options: {
  body: string;
  semanticCodeSearch: SemanticCodeSearchGuidance;
  tools?: string[];
}): { body: string; tools?: string[] } {
  if (!options.tools?.includes("semantic-code-search")) {
    return {
      body: options.body,
      tools: options.tools,
    };
  }

  const resolvedTools = options.tools.flatMap((toolName) => {
    if (toolName !== "semantic-code-search") {
      return [toolName];
    }

    if (options.semanticCodeSearch.kind === "provider") {
      return [options.semanticCodeSearch.toolName];
    }

    return [];
  });
  const dedupedTools = Array.from(new Set(resolvedTools));
  const nextBody = `${options.body}\n\n${buildSemanticCodeSearchBodyBlock(options.semanticCodeSearch)}`;

  return {
    body: nextBody,
    ...(dedupedTools.length > 0 ? { tools: dedupedTools } : {}),
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Serializes frontmatter records with deterministic YAML settings suited to generated agent files.
 *
 * @remarks
 * Disables line wrapping and anchors so diffs remain stable across runs.
 */
function yamlDump(data: Record<string, unknown>): string {
  return yaml.dump(data, {
    lineWidth: -1,
    quotingType: "'",
    forceQuotes: false,
    noRefs: true,
    sortKeys: false,
  });
}

/** Kilo: `.kilo/agents/{id}.md` */
export function formatKiloAgent(
  agent: CanonicalAgent,
  override?: AgentOverride,
  context?: AgentGenerationContext,
): string {
  const merged = mergeAgentWithOverride(agent, override, context);
  const frontmatter = resolveTargetFrontmatter(merged.frontmatter, "kilo");
  const fm: Record<string, unknown> = {
    description: frontmatter.description,
    mode: frontmatter.mode,
  };
  // Include model from override if present
  if (frontmatter.model) fm.model = frontmatter.model;
  // Include permission from override (Kilo-specific)
  if (frontmatter.permission) fm.permission = frontmatter.permission;

  return `---\n${yamlDump(fm)}---\n\n${merged.body}\n`;
}

/** Augment: `.augment/agents/{name}.md` */
export function formatAugmentAgent(
  agent: CanonicalAgent,
  override?: AgentOverride,
  context?: AgentGenerationContext,
): string {
  const merged = mergeAgentWithOverride(agent, override, context);
  const frontmatter = resolveTargetFrontmatter(merged.frontmatter, "augment");
  const name = (frontmatter.name as string) ?? agent.id;
  const fm: Record<string, unknown> = {
    name,
    description: frontmatter.description,
  };
  if (frontmatter.color) fm.color = frontmatter.color;
  if (frontmatter.disabled_tools)
    fm.disabled_tools = frontmatter.disabled_tools;

  return `---\n${yamlDump(fm)}---\n\n${merged.body}\n`;
}

/** pi: `.pi/agents/{name}.md` */
export function formatPiAgent(
  agent: CanonicalAgent,
  override?: AgentOverride,
  context?: AgentGenerationContext,
): string {
  const merged = mergeAgentWithOverride(agent, override, context);
  const frontmatter = resolveTargetFrontmatter(merged.frontmatter, "pi");
  const name = (frontmatter.name as string) ?? agent.id;
  const fm: Record<string, unknown> = {
    name,
    description: frontmatter.description,
  };
  if (frontmatter.model) fm.model = frontmatter.model;
  if (frontmatter.thinking) fm.thinking = frontmatter.thinking;
  if (frontmatter.tools) fm.tools = frontmatter.tools;
  if (frontmatter.defaultProgress !== undefined)
    fm.defaultProgress = frontmatter.defaultProgress;

  // pi convention: no blank line between frontmatter and body
  return `---\n${yamlDump(fm)}---\n${merged.body}\n`;
}

/** Kimi: `.kimi/agents/{id}.yaml` + `.kimi/agents/{id}-system.md` */
export function formatKimiAgent(
  agent: CanonicalAgent,
  override?: AgentOverride,
  context?: AgentGenerationContext,
): KimiAgentOutput {
  const merged = mergeAgentWithOverride(agent, override, context);
  const frontmatter = resolveTargetFrontmatter(merged.frontmatter, "kimi");

  const agentOverride = (frontmatter.agent as Record<string, unknown>) ?? {};
  const agentConfig: Record<string, unknown> = {
    version: 1,
    agent: {
      name: agent.id,
      extend: (agentOverride.extend as string) ?? "default",
      system_prompt_path: `./${agent.id}-system.md`,
    },
  };
  if (agentOverride.tools)
    (agentConfig.agent as Record<string, unknown>).tools = agentOverride.tools;
  if (agentOverride.exclude_tools)
    (agentConfig.agent as Record<string, unknown>).exclude_tools =
      agentOverride.exclude_tools;

  return {
    yaml: yamlDump(agentConfig),
    systemMd: merged.body + "\n",
  };
}

/** Build the root `.kimi/agent.yaml` with subagent references */
export function generateKimiRootYaml(agents: CanonicalAgent[]): string {
  const subagents = agents.filter((a) => a.mode === "subagent");

  const config: Record<string, unknown> = {
    version: 1,
    agent: {
      name: "project",
      extend: "default",
      system_prompt_path: "./agents/code-system.md",
    },
  };

  if (subagents.length > 0) {
    config.subagents = subagents.map((s) => ({
      name: s.id,
      agent_path: `./agents/${s.id}.yaml`,
    }));
  }

  return yamlDump(config);
}

/** Claude Code: `.claude/agents/{id}.md` */
export function formatClaudeCodeAgent(
  agent: CanonicalAgent,
  override?: AgentOverride,
  context?: AgentGenerationContext,
): string {
  const merged = mergeAgentWithOverride(agent, override, context);
  const frontmatter = resolveTargetFrontmatter(
    merged.frontmatter,
    "claude-code",
  );
  const fm: Record<string, unknown> = {
    description: frontmatter.description,
  };
  if (frontmatter.model) fm.model = frontmatter.model;
  if (frontmatter.effort) fm.effort = frontmatter.effort;
  if (frontmatter.permissionMode)
    fm.permissionMode = frontmatter.permissionMode;
  if (frontmatter.tools) fm.tools = frontmatter.tools;
  if (frontmatter.disallowedTools)
    fm.disallowedTools = frontmatter.disallowedTools;
  if (frontmatter.maxTurns) fm.maxTurns = frontmatter.maxTurns;

  return `---\n${yamlDump(fm)}---\n\n${merged.body}\n`;
}

/** Codex: `.codex/agents/{id}.toml` */
export function formatCodexAgent(
  agent: CanonicalAgent,
  override?: AgentOverride,
  context?: AgentGenerationContext,
): string {
  const merged = mergeAgentWithOverride(agent, override, context);
  const frontmatter = resolveTargetFrontmatter(merged.frontmatter, "codex");
  const name = (frontmatter.name as string) ?? agent.id;
  const sandboxMode = normalizeCodexSandboxMode(
    frontmatter.sandbox_mode,
    agent.id,
  );

  // Build TOML manually (avoids smol-toml dependency for now)
  const lines: string[] = [];
  lines.push(`name = "${name.replace(/"/g, '\\"')}"`);
  lines.push(
    `description = "${(frontmatter.description as string).replace(/"/g, '\\"')}"`,
  );
  lines.push(`developer_instructions = """`);
  lines.push(merged.body);
  lines.push(`"""`);

  if (frontmatter.model)
    lines.push(
      `model = "${(frontmatter.model as string).replace(/"/g, '\\"')}"`,
    );
  if (frontmatter.model_reasoning_effort)
    lines.push(
      `model_reasoning_effort = "${(frontmatter.model_reasoning_effort as string).replace(/"/g, '\\"')}"`,
    );
  if (sandboxMode) {
    lines.push(`sandbox_mode = "${sandboxMode}"`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Coerces YAML `sandbox_mode` (or legacy `access`) into allowed Codex sandbox literals.
 *
 * @throws Error when a defined value is not one of the supported sandbox strings for the agent.
 */
function normalizeCodexSandboxMode(
  sandboxMode: unknown,
  agentId: string,
): CodexSandboxMode | undefined {
  if (sandboxMode === undefined) {
    return undefined;
  }

  if (typeof sandboxMode !== "string") {
    throw new Error(
      `Invalid Codex sandbox_mode for ${agentId}: expected string, received ${typeof sandboxMode}.`,
    );
  }

  if (isCodexSandboxMode(sandboxMode)) {
    return sandboxMode;
  }

  throw new Error(
    `Invalid Codex sandbox_mode for ${agentId}: "${sandboxMode}". Expected one of ${codexSandboxModes.join(", ")}.`,
  );
}

/** Type guard ensuring a string token is a supported Codex sandbox preset. */
function isCodexSandboxMode(value: string): value is CodexSandboxMode {
  return (codexSandboxModes as readonly string[]).includes(value);
}

/** Augment command: `.augment/commands/{id}.md` */
export function formatAugmentCommand(command: CanonicalCommand): string {
  const fm: Record<string, unknown> = {
    description: command.description,
  };
  if (command.argumentHint) fm["argument-hint"] = command.argumentHint;

  return `---\n${yamlDump(fm)}---\n\n${command.body}\n`;
}

// ---------------------------------------------------------------------------
// Target definitions
// ---------------------------------------------------------------------------

/** Builds the full agent-target list for all six supported tools (Kilo, Augment, pi, Kimi, Claude Code, Codex). */
export function buildAgentTargets(repoRoot: string): AgentTarget[] {
  return [
    {
      toolId: "kilo",
      name: "Kilo",
      outputDir: path.join(repoRoot, ".kilo", "agents"),
      formatter: formatKiloAgent,
      fileExtension: ".md",
    },
    {
      toolId: "augment",
      name: "Augment",
      outputDir: path.join(repoRoot, ".augment", "agents"),
      formatter: formatAugmentAgent,
      fileExtension: ".md",
      excludeAgents: [
        "auggie-agent-implementation",
        "auggie-agent-study-to-execution",
        "auggie-agent-study-to-decision",
        "auggie-agent-delegation-chain",
        "auggie-agent-release-promotion",
        "auggie-agent-environment-sync",
        "auggie-agent-worktree-lifecycle",
        "auggie-agent-landing-qa",
        "auggie-agent-manager-astro-qa",
        "auggie-agent-manager-next-qa",
        "auggie-agent-cross-manager-parity",
        "auggie-agent-visual-council",
        "auggie-agent-backend-debug",
        "auggie-agent-research-to-expert",
        "auggie-agent-incident-to-skill",
        "auggie-agent-vision-to-standard",
        "auggie-agent-plan-to-promotion",
        "auggie-agent-keystone-modeler",
      ],
    },
    {
      toolId: "pi",
      name: "pi",
      outputDir: path.join(repoRoot, ".pi", "agents"),
      formatter: formatPiAgent,
      fileExtension: ".md",
    },
    {
      toolId: "kimi",
      name: "Kimi",
      outputDir: path.join(repoRoot, ".kimi", "agents"),
      formatter: formatKimiAgent,
      fileExtension: ".yaml",
    },
    {
      toolId: "claude-code",
      name: "Claude Code",
      outputDir: path.join(repoRoot, ".claude", "agents"),
      formatter: formatClaudeCodeAgent,
      fileExtension: ".md",
    },
    {
      toolId: "codex",
      name: "Codex",
      outputDir: path.join(repoRoot, ".codex", "agents"),
      formatter: formatCodexAgent,
      fileExtension: ".toml",
    },
  ];
}

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

/**
 * Derives the on-disk filename for a generated agent artifact per target formatter rules.
 *
 * @remarks
 * Augment resolves `name` through target-specific frontmatter before appending the extension.
 */
function computeOutputFileName(
  agent: CanonicalAgent,
  target: AgentTarget,
  merged: { frontmatter: Record<string, unknown> },
): string {
  // Augment uses `name` from merged frontmatter for filename
  if (target.toolId === "augment") {
    const frontmatter = resolveTargetFrontmatter(
      merged.frontmatter,
      target.toolId,
    );
    const name = (frontmatter.name as string) ?? agent.id;
    return name + target.fileExtension;
  }
  return agent.id + target.fileExtension;
}

/** Writes Kimi per-agent `.yaml` + `-system.md` when either side drifts; otherwise increments unchanged and optional verbose log. */
function syncAgents_writeKimiDualFiles(options: {
  outputDir: string;
  agentId: string;
  kimiOutput: KimiAgentOutput;
  targetName: string;
  log: LogFn;
  verbose: boolean;
  result: SyncResult;
}): void {
  const { outputDir, agentId, kimiOutput, targetName, log, verbose, result } =
    options;
  ensureDir(outputDir, log);
  const yamlPath = path.join(outputDir, `${agentId}.yaml`);
  const mdPath = path.join(outputDir, `${agentId}-system.md`);
  const yamlExisted = fs.existsSync(yamlPath);
  const mdExisted = fs.existsSync(mdPath);
  const yamlChanged = hasDrift(yamlPath, kimiOutput.yaml);
  const mdChanged = hasDrift(mdPath, kimiOutput.systemMd);
  const changed = yamlChanged || mdChanged;
  if (changed) {
    fs.writeFileSync(yamlPath, kimiOutput.yaml, "utf-8");
    fs.writeFileSync(mdPath, kimiOutput.systemMd, "utf-8");
    const verb = yamlExisted && mdExisted ? "Updated" : "Wrote";
    log(`  ${verb} ${targetName}: ${agentId}.yaml + ${agentId}-system.md`);
    result.written++;
  } else {
    result.unchanged++;
    if (verbose) {
      log(`  ${targetName}: ${agentId}.yaml ✓ (up to date)`);
    }
  }
}

/** Check/dry-run path for Kimi dual outputs: drift logging matches legacy suffix rules for system.md. */
function syncAgents_reportKimiDualDrift(options: {
  outputDir: string;
  agentId: string;
  kimiOutput: KimiAgentOutput;
  mode: "dry-run" | "check";
  targetName: string;
  log: LogFn;
  verbose: boolean;
  result: SyncResult;
}): void {
  const {
    outputDir,
    agentId,
    kimiOutput,
    mode,
    targetName,
    log,
    verbose,
    result,
  } = options;
  const yamlPath = path.join(outputDir, `${agentId}.yaml`);
  const mdPath = path.join(outputDir, `${agentId}-system.md`);
  const yamlDrift = hasDrift(yamlPath, kimiOutput.yaml);
  const mdDrift = hasDrift(mdPath, kimiOutput.systemMd);
  if (yamlDrift || mdDrift) {
    if (mode === "check") {
      result.driftDetected++;
    }
    log(
      `  ${mode === "check" ? "DRIFT" : "WOULD WRITE"} ${targetName}: ${agentId}.yaml${mdDrift ? " + system.md" : ""}`,
      mode === "check" ? "warn" : "info",
    );
  } else if (verbose) {
    log(`  ${targetName}: ${agentId}.yaml ✓ (up to date)`);
  }
}

/** Single generated artifact write with mkdir-once semantics for the target output directory. */
function syncAgents_writeSingleGeneratedFile(options: {
  outputDir: string;
  outputPath: string;
  content: string;
  targetName: string;
  outputFileName: string;
  log: LogFn;
  verbose: boolean;
  result: SyncResult;
}): void {
  const {
    outputDir,
    outputPath,
    content,
    targetName,
    outputFileName,
    log,
    verbose,
    result,
  } = options;
  ensureDir(outputDir, log);
  const existed = fs.existsSync(outputPath);
  const changed = hasDrift(outputPath, content);
  if (changed) {
    fs.writeFileSync(outputPath, content, "utf-8");
    const verb = existed ? "Updated" : "Wrote";
    log(`  ${verb} ${targetName}: ${outputFileName}`);
    result.written++;
  } else {
    result.unchanged++;
    if (verbose) {
      log(`  ${targetName}: ${outputFileName} ✓ (up to date)`);
    }
  }
}

/** Non-write modes for a single path: drift vs verbose up-to-date line. */
function syncAgents_reportSingleGeneratedDrift(options: {
  outputPath: string;
  content: string;
  mode: "dry-run" | "check";
  targetName: string;
  outputFileName: string;
  log: LogFn;
  verbose: boolean;
  result: SyncResult;
}): void {
  const {
    outputPath,
    content,
    mode,
    targetName,
    outputFileName,
    log,
    verbose,
    result,
  } = options;
  if (hasDrift(outputPath, content)) {
    if (mode === "check") {
      result.driftDetected++;
    }
    log(
      `  ${mode === "check" ? "DRIFT" : "WOULD WRITE"} ${targetName}: ${outputFileName}`,
      mode === "check" ? "warn" : "info",
    );
  } else if (verbose) {
    log(`  ${targetName}: ${outputFileName} ✓ (up to date)`);
  }
}

/**
 * Writes Kimi root `agent.yaml` when drifted.
 *
 * @remarks
 * Intentionally does not call `ensureDir` — matches historical behavior (parent layout expected).
 */
function syncAgents_writeKimiRootYaml(options: {
  rootPath: string;
  rootYaml: string;
  log: LogFn;
  verbose: boolean;
  result: SyncResult;
}): void {
  const { rootPath, rootYaml, log, verbose, result } = options;
  const existed = fs.existsSync(rootPath);
  const changed = hasDrift(rootPath, rootYaml);
  if (changed) {
    fs.writeFileSync(rootPath, rootYaml, "utf-8");
    const verb = existed ? "Updated" : "Wrote";
    log(`  ${verb} Kimi: agent.yaml (root)`);
    result.written++;
  } else {
    result.unchanged++;
    if (verbose) {
      log(`  Kimi: agent.yaml (root) ✓ (up to date)`);
    }
  }
}

/** Check/dry-run for Kimi root `agent.yaml` beside `.kimi/agents/` (log labels omit "(root)" here). */
function syncAgents_reportKimiRootDrift(options: {
  rootPath: string;
  rootYaml: string;
  mode: "dry-run" | "check";
  log: LogFn;
  verbose: boolean;
  result: SyncResult;
}): void {
  const { rootPath, rootYaml, mode, log, verbose, result } = options;
  if (hasDrift(rootPath, rootYaml)) {
    if (mode === "check") {
      result.driftDetected++;
    }
    log(
      `  ${mode === "check" ? "DRIFT" : "WOULD WRITE"} Kimi: agent.yaml`,
      mode === "check" ? "warn" : "info",
    );
  } else if (verbose) {
    log(`  Kimi: agent.yaml ✓ (up to date)`);
  }
}

/** Syncs all agents to all targets. In "check" mode, counts drift; in "write" mode, writes files; in "dry-run" mode, logs without writing. */
export function syncAgents(
  agents: CanonicalAgent[],
  overrides: Map<string, Map<string, AgentOverride>>,
  targets: AgentTarget[],
  mode: CanonicalAgentsLib_SyncMode,
  context: AgentGenerationContext | undefined,
  log: LogFn,
  options: { verbose?: boolean } = {},
): SyncResult {
  const verbose = options.verbose ?? false;
  const result: SyncResult = {
    generated: 0,
    skipped: 0,
    driftDetected: 0,
    errors: 0,
    written: 0,
    unchanged: 0,
  };

  for (const target of targets) {
    const toolOverrides = overrides.get(target.toolId) ?? new Map();

    for (const agent of agents) {
      if (target.excludeAgents?.includes(agent.id)) continue;

      const override = toolOverrides.get(agent.id);
      const merged = mergeAgentWithOverride(agent, override);
      const outputFileName = computeOutputFileName(agent, target, merged);
      const outputPath = path.join(target.outputDir, outputFileName);

      try {
        const formatterResult = target.formatter(agent, override, context);

        // Kimi is special: produces two files per agent
        if (target.toolId === "kimi") {
          const kimiOutput = formatterResult as KimiAgentOutput;
          if (mode === "write") {
            syncAgents_writeKimiDualFiles({
              outputDir: target.outputDir,
              agentId: agent.id,
              kimiOutput,
              targetName: target.name,
              log,
              verbose,
              result,
            });
          } else {
            syncAgents_reportKimiDualDrift({
              outputDir: target.outputDir,
              agentId: agent.id,
              kimiOutput,
              mode,
              targetName: target.name,
              log,
              verbose,
              result,
            });
          }
          result.generated++;
          continue;
        }

        const content = formatterResult as string;

        if (mode === "write") {
          syncAgents_writeSingleGeneratedFile({
            outputDir: target.outputDir,
            outputPath,
            content,
            targetName: target.name,
            outputFileName,
            log,
            verbose,
            result,
          });
        } else {
          syncAgents_reportSingleGeneratedDrift({
            outputPath,
            content,
            mode,
            targetName: target.name,
            outputFileName,
            log,
            verbose,
            result,
          });
        }
        result.generated++;
      } catch (err: unknown) {
        result.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        log(`  ERROR ${target.name}/${agent.id}: ${msg}`, "error");
      }
    }
  }

  // Generate Kimi root agent.yaml
  const kimiTarget = targets.find((t) => t.toolId === "kimi");
  if (kimiTarget) {
    const rootYaml = generateKimiRootYaml(agents);
    const rootPath = path.join(
      path.dirname(kimiTarget.outputDir),
      "agent.yaml",
    );

    if (mode === "write") {
      syncAgents_writeKimiRootYaml({
        rootPath,
        rootYaml,
        log,
        verbose,
        result,
      });
    } else {
      syncAgents_reportKimiRootDrift({
        rootPath,
        rootYaml,
        mode,
        log,
        verbose,
        result,
      });
    }
    result.generated++;
  }

  return result;
}

/** Applies write/check/dry-run semantics for one Augment command file; mutates `result` counters (not `generated`). */
function syncCommands_processAugmentCommandIteration(options: {
  command: CanonicalCommand;
  commandsOutputDir: string;
  mode: CanonicalAgentsLib_SyncMode;
  log: LogFn;
  verbose: boolean;
  result: SyncResult;
}): void {
  const { command, commandsOutputDir, mode, log, verbose, result } = options;
  const content = formatAugmentCommand(command);
  const outputPath = path.join(commandsOutputDir, `${command.id}.md`);

  if (mode === "write") {
    ensureDir(commandsOutputDir, log);
    const existed = fs.existsSync(outputPath);
    const changed = hasDrift(outputPath, content);
    if (changed) {
      fs.writeFileSync(outputPath, content, "utf-8");
      const verb = existed ? "Updated" : "Wrote";
      log(`  ${verb} Augment command: ${command.id}.md`);
      result.written++;
    } else {
      result.unchanged++;
      if (verbose) {
        log(`  Augment command: ${command.id}.md ✓ (up to date)`);
      }
    }
  } else {
    if (hasDrift(outputPath, content)) {
      if (mode === "check") result.driftDetected++;
      log(
        `  ${mode === "check" ? "DRIFT" : "WOULD WRITE"} Augment command: ${command.id}.md`,
        mode === "check" ? "warn" : "info",
      );
    } else if (verbose) {
      log(`  Augment command: ${command.id}.md ✓ (up to date)`);
    }
  }
}

/** Syncs Augment command files to commandsOutputDir. Generates formatAugmentCommand output for each command. */
export function syncCommands(
  commands: CanonicalCommand[],
  commandsOutputDir: string,
  mode: CanonicalAgentsLib_SyncMode,
  log: LogFn,
  options: { verbose?: boolean } = {},
): SyncResult {
  const verbose = options.verbose ?? false;
  const result: SyncResult = {
    generated: 0,
    skipped: 0,
    driftDetected: 0,
    errors: 0,
    written: 0,
    unchanged: 0,
  };

  for (const command of commands) {
    try {
      syncCommands_processAugmentCommandIteration({
        command,
        commandsOutputDir,
        mode,
        log,
        verbose,
        result,
      });
      result.generated++;
    } catch (err: unknown) {
      result.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR command/${command.id}: ${msg}`, "error");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a missing output directory tree before sync writes, logging when a new path materializes.
 *
 * @remarks
 * Synchronous mkdir matches the rest of the sync engine’s filesystem usage.
 */
function ensureDir(dir: string, log: LogFn): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log(`Created directory: ${dir}`);
  }
}

/**
 * Detects whether disk content differs from freshly generated output for check/dry-run modes.
 *
 * @remarks
 * Missing files are treated as drift so first-run paths surface as writes or warnings.
 */
function hasDrift(filePath: string, expectedContent: string): boolean {
  if (!fs.existsSync(filePath)) return true;
  const actual = fs.readFileSync(filePath, "utf-8");
  return actual !== expectedContent;
}
