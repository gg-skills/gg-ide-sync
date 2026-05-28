/**
 * @fileoverview Verifies canonical IDE rule parsing and target rendering.
 *
 * These tests protect the phase 1 rule generator from target-scope expansion and frontmatter
 * projection drift.
 *
 * @testing Jest unit: NODE_OPTIONS='--experimental-vm-modules' npx jest --config skills/ide-sync/jest.config.ts skills/ide-sync/scripts/__tests__/canonical-rules.unit.test.ts
 * @see ../canonical-rules/rule-schema.ts - Canonical rule schema under test.
 * @see ../canonical-rules/targets.ts - Target renderer matrix under test.
 * @documentation reviewed=2026-04-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { describe, expect, it } from "@jest/globals";

import { parseCanonicalRuleMarkdown } from "../canonical-rules/rule-schema";
import {
  buildCanonicalRuleOutputPath,
  CANONICAL_RULE_TARGETS,
  renderCanonicalRuleOutput,
  renderCanonicalRuleOutputs,
} from "../canonical-rules/targets";

const readAgentsRuleMarkdown = [
  "---",
  "id: read-agents-guidance",
  "description: Always read AGENTS.md files for every folder touched before starting task work.",
  "activation: RULE_ACTIVATION_ALWAYS_ON",
  "---",
  "",
  "Always read AGENTS.md files of every folder you work in before starting any task.",
  "",
].join("\n");

/**
 * Resolves a phase-1 canonical rule target fixture by stable id for renderer tests.
 *
 * @param targetId - Must match an entry id in `CANONICAL_RULE_TARGETS`.
 * @throws Error when the registry does not include the requested target id.
 * @returns The matching target row passed into renderer helpers.
 */
function findTarget(targetId: string) {
  const target = CANONICAL_RULE_TARGETS.find((candidateTarget) => candidateTarget.id === targetId);
  if (!target) {
    throw new Error(`Missing target fixture: ${targetId}`);
  }

  return target;
}

describe("parseCanonicalRuleMarkdown", () => {
  it("parses the first migrated canonical rule", () => {
    const rule = parseCanonicalRuleMarkdown({
      content: readAgentsRuleMarkdown,
      sourcePath: "canonical-rules/read-agents-guidance.md",
    });

    expect(rule).toEqual({
      activation: "RULE_ACTIVATION_ALWAYS_ON",
      body: "Always read AGENTS.md files of every folder you work in before starting any task.",
      description:
        "Always read AGENTS.md files for every folder touched before starting task work.",
      globs: [],
      id: "read-agents-guidance",
      sourcePath: "canonical-rules/read-agents-guidance.md",
      targets: {
        antigravity: { enabled: true },
        cursor: { enabled: true },
        trae: { enabled: true },
        windsurf: { enabled: true },
      },
    });
  });

  it("requires globs for glob-activated rules", () => {
    expect(() =>
      parseCanonicalRuleMarkdown({
        content: [
          "---",
          "id: typescript-contracts",
          "description: Apply when TypeScript contracts are edited.",
          "activation: RULE_ACTIVATION_GLOB",
          "---",
          "",
          "Use shared contract literals exactly.",
        ].join("\n"),
        sourcePath: "canonical-rules/typescript-contracts.md",
      }),
    ).toThrow("RULE_ACTIVATION_GLOB rules must include a non-empty globs array.");
  });

  it("rejects targets outside the admitted phase 1 target set", () => {
    expect(() =>
      parseCanonicalRuleMarkdown({
        content: [
          "---",
          "id: rejected-opencode",
          "description: This target belongs to phase 3.",
          "activation: RULE_ACTIVATION_ALWAYS_ON",
          "targets:",
          "  opencode:",
          "    enabled: true",
          "---",
          "",
          "Do not render this rule.",
        ].join("\n"),
        sourcePath: "canonical-rules/rejected-opencode.md",
      }),
    ).toThrow("unknown target override(s): opencode");
  });
});

describe("canonical rule target renderers", () => {
  const rule = parseCanonicalRuleMarkdown({
    content: readAgentsRuleMarkdown,
    sourcePath: "canonical-rules/read-agents-guidance.md",
  });

  it("uses canonical-rule output paths for all phase 1 targets", () => {
    expect(
      CANONICAL_RULE_TARGETS.map((target) => buildCanonicalRuleOutputPath(rule, target)),
    ).toEqual([
      ".cursor/rules/generated-rules--read-agents-guidance.mdc",
      ".windsurf/rules/generated-rules--read-agents-guidance.md",
      ".agents/rules/generated-rules--read-agents-guidance.md",
      ".trae/rules/generated-rules--read-agents-guidance.md",
    ]);
  });

  it("renders the always-on rule for Cursor", () => {
    const output = renderCanonicalRuleOutput(rule, findTarget("cursor"));

    expect(output.content).toBe(
      [
        "---",
        [
          "description: \"Always read AGENTS.md files for every folder touched before starting",
          "task work.\"",
        ].join(" "),
        "alwaysApply: true",
        "---",
        "",
        "Always read AGENTS.md files of every folder you work in before starting any task.",
        "",
      ].join("\n"),
    );
  });

  it("renders the always-on rule for Windsurf and Antigravity", () => {
    expect(renderCanonicalRuleOutput(rule, findTarget("windsurf")).content).toBe(
      [
        "---",
        "trigger: \"always_on\"",
        "---",
        "",
        "Always read AGENTS.md files of every folder you work in before starting any task.",
        "",
      ].join("\n"),
    );
    expect(renderCanonicalRuleOutput(rule, findTarget("antigravity")).content).toBe(
      [
        "---",
        "trigger: \"always_on\"",
        "---",
        "",
        "Always read AGENTS.md files of every folder you work in before starting any task.",
        "",
      ].join("\n"),
    );
  });

  it("renders the always-on rule for Trae without scene frontmatter", () => {
    const output = renderCanonicalRuleOutput(rule, findTarget("trae"));

    expect(output.content).toBe(
      [
        "---",
        "alwaysApply: true",
        "---",
        "",
        "Always read AGENTS.md files of every folder you work in before starting any task.",
        "",
      ].join("\n"),
    );
    expect(output.content).not.toContain("scene:");
  });

  it("omits disabled target outputs", () => {
    const cursorOnlyRule = parseCanonicalRuleMarkdown({
      content: [
        "---",
        "id: cursor-only",
        "description: Cursor-only rule.",
        "activation: RULE_ACTIVATION_MANUAL",
        "targets:",
        "  windsurf:",
        "    enabled: false",
        "  antigravity:",
        "    enabled: false",
        "  trae:",
        "    enabled: false",
        "---",
        "",
        "Mention manually.",
      ].join("\n"),
      sourcePath: "canonical-rules/cursor-only.md",
    });

    const outputPaths = renderCanonicalRuleOutputs([cursorOnlyRule]).map(
      (output) => output.relativePath,
    );

    expect(outputPaths).toEqual([".cursor/rules/generated-rules--cursor-only.mdc"]);
  });
});
