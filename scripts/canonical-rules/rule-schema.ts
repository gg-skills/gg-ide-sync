/**
 * @fileoverview Canonical IDE rule schema parser and validator.
 *
 * This module owns the committed `canonical-rules/*.md` schema that feeds target-specific IDE rule folders.
 * Flow: markdown frontmatter -> validated canonical rule -> target renderers.
 *
 * @testing Jest unit: NODE_OPTIONS='--experimental-vm-modules' npx jest --config jest.config.ts scripts/__tests__/canonical-rules.unit.test.ts
 * @see scripts/canonical-rules/targets.ts - Target-specific renderer matrix for canonical rules.
 * @see scripts/canonical-rules/sync-canonical.ts - CLI entrypoint that loads and writes rule projections.
 * @documentation reviewed=2026-04-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

/** Repository-relative directory containing committed canonical rule markdown (`canonical-rules/*.md`). */
export const CANONICAL_RULES_DIR = "canonical-rules" as const;

/** Closed-set activation modes allowed in canonical rule YAML frontmatter. */
export const CANONICAL_RULE_ACTIVATIONS = [
  "RULE_ACTIVATION_ALWAYS_ON",
  "RULE_ACTIVATION_MODEL_DECISION",
  "RULE_ACTIVATION_GLOB",
  "RULE_ACTIVATION_MANUAL",
] as const;

/** Activation discriminator parsed from canonical `canonical-rules/*.md` frontmatter. */
export type CanonicalRuleActivation = (typeof CANONICAL_RULE_ACTIVATIONS)[number];

/** Phase-1 IDE target identifiers supported for rule projection outputs. */
export const CANONICAL_RULE_TARGET_IDS = [
  "cursor",
  "windsurf",
  "antigravity",
  "trae",
] as const;

/** Target id union aligned with `CANONICAL_RULE_TARGET_IDS` literals. */
export type CanonicalRuleTargetId = (typeof CANONICAL_RULE_TARGET_IDS)[number];

/** Per-target enablement flag parsed from optional frontmatter `targets` overrides. */
export type CanonicalRuleTargetOptions = {
  enabled: boolean;
};

/** Default and override per-target enablement for a single canonical rule. */
export type CanonicalRuleTargets = {
  antigravity: CanonicalRuleTargetOptions;
  cursor: CanonicalRuleTargetOptions;
  trae: CanonicalRuleTargetOptions;
  windsurf: CanonicalRuleTargetOptions;
};

/** Normalized canonical rule after YAML frontmatter and markdown body validation. */
export type CanonicalRule = {
  activation: CanonicalRuleActivation;
  body: string;
  description: string;
  globs: string[];
  id: string;
  sourcePath: string;
  targets: CanonicalRuleTargets;
};

/** Inputs for parsing one canonical rule markdown string without reading the filesystem. */
export type ParseCanonicalRuleMarkdownOptions = {
  content: string;
  sourcePath: string;
};

const FRONTMATTER_PATTERN = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]*/;
const RULE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Narrows unknown YAML/JSON values to non-null plain objects (excludes arrays).
 *
 * @remarks
 * Arrays are excluded so callers treat sequence roots as distinct from mapping roots.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows unknown values to homogeneous string arrays for frontmatter list fields.
 *
 * @remarks
 * Does not trim or reject blank entries; callers normalize after narrowing succeeds.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates activation strings against the canonical closed-set union.
 *
 * @remarks
 * Uses the committed literal list so unexpected activation tokens fail parsing upstream.
 */
function isCanonicalRuleActivation(value: unknown): value is CanonicalRuleActivation {
  return (
    typeof value === "string" &&
    CANONICAL_RULE_ACTIVATIONS.includes(value as CanonicalRuleActivation)
  );
}

/**
 * Builds a parse error tagged with the repository-relative rule path.
 *
 * @remarks
 * Prefix format keeps multi-file loads attributable in thrown stack traces and logs.
 */
function formatSourceError(sourcePath: string, message: string): Error {
  return new Error(`${sourcePath}: ${message}`);
}

/**
 * Reads a required non-empty string field from parsed frontmatter.
 *
 * @remarks
 * Throws via `formatSourceError` when missing, wrong type, or whitespace-only after trim.
 */
function readRequiredString(
  frontmatter: Record<string, unknown>,
  key: string,
  sourcePath: string,
): string {
  const value = frontmatter[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw formatSourceError(sourcePath, `frontmatter field "${key}" must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * Parses an optional string-array frontmatter field with trim and blank rejection.
 *
 * @remarks
 * Absent keys yield an empty array. Throws when the field is present but not a string array or
 * contains blank entries after trimming.
 */
function parseOptionalStringArray(
  frontmatter: Record<string, unknown>,
  key: string,
  sourcePath: string,
): string[] {
  const value = frontmatter[key];
  if (typeof value === "undefined") {
    return [];
  }

  if (!isStringArray(value)) {
    throw formatSourceError(sourcePath, `frontmatter field "${key}" must be a string array.`);
  }

  const normalizedValues = value.map((item) => item.trim()).filter((item) => item.length > 0);
  if (normalizedValues.length !== value.length) {
    throw formatSourceError(sourcePath, `frontmatter field "${key}" cannot contain blank values.`);
  }

  return normalizedValues;
}

/**
 * Builds per-target enablement defaults before optional frontmatter overrides apply.
 *
 * @remarks
 * Phase-1 policy enables every supported IDE target unless explicitly overridden.
 */
function buildDefaultTargets(): CanonicalRuleTargets {
  return {
    antigravity: { enabled: true },
    cursor: { enabled: true },
    trae: { enabled: true },
    windsurf: { enabled: true },
  };
}

/**
 * Rejects unknown keys inside frontmatter `targets` overrides.
 *
 * @remarks
 * Prevents silent typos from skipping projection while keeping phase-1 target IDs closed-set.
 */
function assertKnownTargetKeys(targets: Record<string, unknown>, sourcePath: string): void {
  const knownTargetIds = new Set<string>(CANONICAL_RULE_TARGET_IDS);
  const unknownTargetIds = Object.keys(targets).filter((targetId) => !knownTargetIds.has(targetId));
  if (unknownTargetIds.length > 0) {
    throw formatSourceError(
      sourcePath,
      [
        `unknown target override(s): ${unknownTargetIds.join(", ")}.`,
        `Phase 1 supports ${CANONICAL_RULE_TARGET_IDS.join(", ")}.`,
      ].join(" "),
    );
  }
}

/**
 * Parses `{ enabled }` for one IDE target override entry.
 *
 * @remarks
 * Omits `enabled` defaults to `true`. Throws when the shape is not an object or `enabled` is not boolean.
 */
function parseTargetOptions(
  value: unknown,
  targetId: string,
  sourcePath: string,
): CanonicalRuleTargetOptions {
  if (!isRecord(value)) {
    throw formatSourceError(sourcePath, `targets.${targetId} must be an object.`);
  }

  const enabled = value.enabled;
  if (typeof enabled === "undefined") {
    return { enabled: true };
  }

  if (typeof enabled !== "boolean") {
    throw formatSourceError(sourcePath, `targets.${targetId}.enabled must be a boolean.`);
  }

  return { enabled };
}

/**
 * Merges optional frontmatter `targets` overrides into default per-target enablement.
 *
 * @remarks
 * Validates unknown keys and delegates per-target parsing to `parseTargetOptions`.
 */
function parseTargets(
  frontmatter: Record<string, unknown>,
  sourcePath: string,
): CanonicalRuleTargets {
  const targets = buildDefaultTargets();
  const rawTargets = frontmatter.targets;
  if (typeof rawTargets === "undefined") {
    return targets;
  }

  if (!isRecord(rawTargets)) {
    throw formatSourceError(sourcePath, "frontmatter field \"targets\" must be an object.");
  }

  assertKnownTargetKeys(rawTargets, sourcePath);

  if (typeof rawTargets.antigravity !== "undefined") {
    targets.antigravity = parseTargetOptions(rawTargets.antigravity, "antigravity", sourcePath);
  }
  if (typeof rawTargets.cursor !== "undefined") {
    targets.cursor = parseTargetOptions(rawTargets.cursor, "cursor", sourcePath);
  }
  if (typeof rawTargets.trae !== "undefined") {
    targets.trae = parseTargetOptions(rawTargets.trae, "trae", sourcePath);
  }
  if (typeof rawTargets.windsurf !== "undefined") {
    targets.windsurf = parseTargetOptions(rawTargets.windsurf, "windsurf", sourcePath);
  }

  return targets;
}

/**
 * Extracts YAML frontmatter and markdown body using the canonical delimiter pattern.
 *
 * @remarks
 * I/O: none; uses `yaml.load` on the fenced frontmatter block. Throws when delimiters are missing or YAML does not parse to an object.
 */
function parseFrontmatter(sourcePath: string, content: string): {
  body: string;
  frontmatter: Record<string, unknown>;
} {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match || typeof match[1] !== "string") {
    throw formatSourceError(sourcePath, "canonical rule file must start with YAML frontmatter.");
  }

  const loadedFrontmatter = yaml.load(match[1]);
  if (!isRecord(loadedFrontmatter)) {
    throw formatSourceError(sourcePath, "frontmatter must parse to a YAML object.");
  }

  return {
    body: content.slice(match[0].length).trim(),
    frontmatter: loadedFrontmatter,
  };
}

/**
 * Parses YAML frontmatter and markdown body for one canonical `canonical-rules/*.md` document.
 *
 * @remarks
 * I/O: none beyond in-memory parsing. Throws descriptive `Error` values when frontmatter fields,
 * activation/glob pairing, or body constraints are violated.
 */
export function parseCanonicalRuleMarkdown(
  options: ParseCanonicalRuleMarkdownOptions,
): CanonicalRule {
  const { body, frontmatter } = parseFrontmatter(options.sourcePath, options.content);
  const id = readRequiredString(frontmatter, "id", options.sourcePath);
  if (!RULE_ID_PATTERN.test(id)) {
    throw formatSourceError(
      options.sourcePath,
      `frontmatter field "id" must use lowercase kebab-case; received "${id}".`,
    );
  }

  const description = readRequiredString(frontmatter, "description", options.sourcePath);
  const activation = frontmatter.activation;
  if (!isCanonicalRuleActivation(activation)) {
    throw formatSourceError(
      options.sourcePath,
      `frontmatter field "activation" must be one of ${CANONICAL_RULE_ACTIVATIONS.join(", ")}.`,
    );
  }

  const globs = parseOptionalStringArray(frontmatter, "globs", options.sourcePath);
  if (activation === "RULE_ACTIVATION_GLOB" && globs.length === 0) {
    throw formatSourceError(
      options.sourcePath,
      "RULE_ACTIVATION_GLOB rules must include a non-empty globs array.",
    );
  }

  if (activation !== "RULE_ACTIVATION_GLOB" && globs.length > 0) {
    throw formatSourceError(
      options.sourcePath,
      "globs are only supported for RULE_ACTIVATION_GLOB canonical rules.",
    );
  }

  if (body.length === 0) {
    throw formatSourceError(options.sourcePath, "canonical rule body cannot be empty.");
  }

  return {
    activation,
    body,
    description,
    globs,
    id,
    sourcePath: options.sourcePath,
    targets: parseTargets(frontmatter, options.sourcePath),
  };
}

/**
 * Loads every non-`AGENTS.md` `.md` file from `canonical-rules/` under `repoRoot` and parses them into canonical rules.
 *
 * @remarks
 * I/O: synchronous filesystem reads via `fs.readdirSync` and `fs.readFileSync`. Returns an empty
 * array when the rules directory is missing.
 */
export function loadCanonicalRules(repoRoot = process.cwd()): CanonicalRule[] {
  const rulesDirectory = path.join(repoRoot, CANONICAL_RULES_DIR);
  if (!fs.existsSync(rulesDirectory)) {
    return [];
  }

  return fs
    .readdirSync(rulesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "AGENTS.md")
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => {
      const sourcePath = path.join(CANONICAL_RULES_DIR, fileName);
      const absolutePath = path.join(repoRoot, sourcePath);
      return parseCanonicalRuleMarkdown({
        content: fs.readFileSync(absolutePath, "utf8"),
        sourcePath: sourcePath.split(path.sep).join("/"),
      });
    });
}
