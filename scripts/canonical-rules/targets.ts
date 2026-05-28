/**
 * @fileoverview Target renderers for canonical IDE rule projections.
 *
 * This module maps target-neutral `canonical-rules/*.md` activation semantics into the native phase 1
 * rule-folder formats for Cursor, Windsurf, Antigravity, and Trae.
 * Flow: canonical rule -> target frontmatter -> generated `generated-rules--*` output path.
 *
 * @testing Jest unit: NODE_OPTIONS='--experimental-vm-modules' npx jest --config jest.config.ts scripts/__tests__/canonical-rules.unit.test.ts
 * @see scripts/canonical-rules/rule-schema.ts - Canonical rule schema and parser.
 * @see scripts/canonical-rules/sync-canonical.ts - CLI writer that consumes these target renderers.
 * @documentation reviewed=2026-04-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import path from "node:path";

import {
  type CanonicalRule,
  type CanonicalRuleTargetId,
} from "./rule-schema";

/** Filename prefix for generated canonical rule outputs inside each IDE target directory. */
export const CANONICAL_RULE_OUTPUT_PREFIX = "generated-rules--" as const;

/** Describes one IDE target directory, file extension, and human-readable label for sync logs. */
export type CanonicalRuleTarget = {
  directory: string;
  extension: ".md" | ".mdc";
  id: CanonicalRuleTargetId;
  name: string;
};

/** Rendered markdown payload plus repo-relative destination path for one rule/target pair. */
export type CanonicalRuleTargetOutput = {
  content: string;
  relativePath: string;
  ruleId: string;
  target: CanonicalRuleTarget;
};

/**
 * Scalar shapes permitted inside YAML frontmatter values when rendering rule markdown.
 *
 * @remarks
 * Arrays serialize as YAML list items; booleans and strings use YAML-native literals (strings via `quoteYamlString`).
 */
type FrontmatterValue = boolean | string | string[];

/**
 * Frontmatter key map used by `renderRuleMarkdown`.
 *
 * @remarks
 * Keys with `undefined` values are omitted from output.
 */
type FrontmatterFields = Record<string, FrontmatterValue | undefined>;

export const CANONICAL_RULE_TARGETS: CanonicalRuleTarget[] = [
  {
    directory: ".cursor/rules",
    extension: ".mdc",
    id: "cursor",
    name: "Cursor",
  },
  {
    directory: ".windsurf/rules",
    extension: ".md",
    id: "windsurf",
    name: "Windsurf",
  },
  {
    directory: ".agents/rules",
    extension: ".md",
    id: "antigravity",
    name: "Antigravity",
  },
  {
    directory: ".trae/rules",
    extension: ".md",
    id: "trae",
    name: "Trae",
  },
];

/**
 * Serializes a string as a YAML-safe quoted scalar using JSON string quoting rules.
 *
 * @remarks
 * PURITY: delegates to `JSON.stringify`; stable for ASCII and Unicode content Cursor/Windsurf frontmatter accepts.
 */
function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Renders one frontmatter field into YAML lines under its key.
 *
 * @remarks
 * PURITY: string assembly only; arrays become indented `-` list entries.
 */
function renderFrontmatterValue(key: string, value: FrontmatterValue): string[] {
  if (Array.isArray(value)) {
    return [key + ":", ...value.map((item) => `  - ${quoteYamlString(item)}`)];
  }

  if (typeof value === "boolean") {
    return [`${key}: ${value ? "true" : "false"}`];
  }

  return [`${key}: ${quoteYamlString(value)}`];
}

/**
 * Builds a markdown document with YAML frontmatter lines followed by the rule body.
 *
 * @remarks
 * PURITY: string assembly only; omits keys whose values are `undefined`.
 */
export function renderRuleMarkdown(frontmatter: FrontmatterFields, body: string): string {
  const frontmatterLines = Object.entries(frontmatter).flatMap(([key, value]) => {
    if (typeof value === "undefined") {
      return [];
    }

    return renderFrontmatterValue(key, value);
  });

  return ["---", ...frontmatterLines, "---", "", body.trimEnd(), ""].join("\n");
}

/**
 * Renders a canonical rule into Cursor `.mdc` frontmatter plus body.
 *
 * @remarks
 * PURITY: maps `rule.activation` to `alwaysApply`, optional `globs`, and `description` fields expected by Cursor.
 */
function renderCursorRule(rule: CanonicalRule): string {
  switch (rule.activation) {
    case "RULE_ACTIVATION_ALWAYS_ON":
      return renderRuleMarkdown(
        {
          description: rule.description,
          alwaysApply: true,
        },
        rule.body,
      );
    case "RULE_ACTIVATION_MODEL_DECISION":
      return renderRuleMarkdown(
        {
          description: rule.description,
          alwaysApply: false,
        },
        rule.body,
      );
    case "RULE_ACTIVATION_GLOB":
      return renderRuleMarkdown(
        {
          description: rule.description,
          globs: rule.globs,
          alwaysApply: false,
        },
        rule.body,
      );
    case "RULE_ACTIVATION_MANUAL":
      return renderRuleMarkdown(
        {
          alwaysApply: false,
        },
        rule.body,
      );
  }
}

/**
 * Renders a canonical rule into Windsurf- and Antigravity-style `trigger` frontmatter plus body.
 *
 * @remarks
 * PURITY: shared shape for targets that use `trigger` instead of Cursor's `alwaysApply` matrix.
 */
function renderWindsurfLikeRule(rule: CanonicalRule): string {
  switch (rule.activation) {
    case "RULE_ACTIVATION_ALWAYS_ON":
      return renderRuleMarkdown(
        {
          trigger: "always_on",
        },
        rule.body,
      );
    case "RULE_ACTIVATION_MODEL_DECISION":
      return renderRuleMarkdown(
        {
          trigger: "model_decision",
          description: rule.description,
        },
        rule.body,
      );
    case "RULE_ACTIVATION_GLOB":
      return renderRuleMarkdown(
        {
          trigger: "glob",
          globs: rule.globs,
        },
        rule.body,
      );
    case "RULE_ACTIVATION_MANUAL":
      return renderRuleMarkdown(
        {
          trigger: "manual",
        },
        rule.body,
      );
  }
}

/**
 * Renders a canonical rule into Trae rule frontmatter plus body.
 *
 * @remarks
 * PURITY: Trae uses `alwaysApply` plus optional `description`/`globs` without a separate trigger enum.
 */
function renderTraeRule(rule: CanonicalRule): string {
  switch (rule.activation) {
    case "RULE_ACTIVATION_ALWAYS_ON":
      return renderRuleMarkdown(
        {
          alwaysApply: true,
        },
        rule.body,
      );
    case "RULE_ACTIVATION_MODEL_DECISION":
      return renderRuleMarkdown(
        {
          description: rule.description,
          alwaysApply: false,
        },
        rule.body,
      );
    case "RULE_ACTIVATION_GLOB":
      return renderRuleMarkdown(
        {
          globs: rule.globs,
          alwaysApply: false,
        },
        rule.body,
      );
    case "RULE_ACTIVATION_MANUAL":
      return renderRuleMarkdown(
        {
          alwaysApply: false,
        },
        rule.body,
      );
  }
}

/**
 * Dispatches rendering to the IDE-specific frontmatter strategy for `target.id`.
 *
 * @remarks
 * PURITY: switches only; Antigravity reuses the Windsurf-like renderer by shared contract.
 */
function renderCanonicalRuleForTarget(rule: CanonicalRule, target: CanonicalRuleTarget): string {
  switch (target.id) {
    case "cursor":
      return renderCursorRule(rule);
    case "windsurf":
      return renderWindsurfLikeRule(rule);
    case "antigravity":
      return renderWindsurfLikeRule(rule);
    case "trae":
      return renderTraeRule(rule);
  }
}

/**
 * Computes the POSIX relative output path for a canonical rule inside a target directory.
 *
 * @remarks
 * PURITY: path join only; encodes `CANONICAL_RULE_OUTPUT_PREFIX` and per-target extension rules.
 */
export function buildCanonicalRuleOutputPath(
  rule: CanonicalRule,
  target: CanonicalRuleTarget,
): string {
  return path.posix.join(
    target.directory,
    `${CANONICAL_RULE_OUTPUT_PREFIX}${rule.id}${target.extension}`,
  );
}

/**
 * Renders one canonical rule into the native markdown/mdc shape for a specific IDE target.
 *
 * @remarks
 * PURITY: delegates to target-specific renderers without filesystem I/O.
 */
export function renderCanonicalRuleOutput(
  rule: CanonicalRule,
  target: CanonicalRuleTarget,
): CanonicalRuleTargetOutput {
  return {
    content: renderCanonicalRuleForTarget(rule, target),
    relativePath: buildCanonicalRuleOutputPath(rule, target),
    ruleId: rule.id,
    target,
  };
}

/**
 * Expands enabled targets for every input rule into the full cross-product of projection outputs.
 *
 * @remarks
 * PURITY: filters disabled targets via `rule.targets[target.id].enabled` before rendering.
 */
export function renderCanonicalRuleOutputs(rules: CanonicalRule[]): CanonicalRuleTargetOutput[] {
  return CANONICAL_RULE_TARGETS.flatMap((target) =>
    rules
      .filter((rule) => rule.targets[target.id].enabled)
      .map((rule) => renderCanonicalRuleOutput(rule, target)),
  );
}
