/**
 * @fileoverview Unit tests for the root agents-guidance sync pipeline.
 *
 * Verifies harness-guidance generation, Codex config patching, and cleanup
 * behavior. These tests protect the Codex guidance runtime contract:
 * tracked `AGENTS.md` + tracked `CODEX.md` -> generated `AGENTS.CODEX.md` +
 * `.codex/config.toml#model_instructions_file`.
 *
 * @testing Jest unit: NODE_OPTIONS='--experimental-vm-modules' npx jest --config skills/ide-sync/jest.config.ts skills/ide-sync/scripts/__tests__/agents-guidance.unit.test.ts
 * @see ../agents-guidance/lib.ts - Shared sync helpers and target-specific renderers under test.
 * @documentation reviewed=2026-04-30 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "@jest/globals";

import {
  buildCodexGuidanceContent,
  rewriteWorkspaceAbsolutePathsInTextContent,
  syncAgentsGuidance,
  updateCodexConfigContent,
} from "../agents-guidance/lib";

describe("buildCodexGuidanceContent", () => {
  it("merges shared and Codex-specific guidance into a deterministic generated artifact", () => {
    const output = buildCodexGuidanceContent({
      agentsContent: "# Shared\n\nUse AGENTS.",
      codexContent: "# Codex\n\nUse Codex.",
    });

    expect(output).toBe(
      [
        "<!-- GENERATED FILE. DO NOT EDIT DIRECTLY. -->",
        "<!-- Source files: AGENTS.md, CODEX.md -->",
        "<!-- Regenerate with: npm run agents:sync -->",
        "",
        "# Shared",
        "",
        "Use AGENTS.",
        "",
        "<!-- Codex-specific guidance from CODEX.md -->",
        "",
        "# Codex",
        "",
        "Use Codex.",
        "",
      ].join("\n"),
    );
  });
});

describe("updateCodexConfigContent", () => {
  it("inserts model_instructions_file before existing tables while preserving unrelated config", () => {
    const output = updateCodexConfigContent({
      guidanceFilePath: "/tmp/repo/AGENTS.CODEX.md",
      rawConfigContent: [
        "[mcp_servers.serena-stdio]",
        'command = "uvx"',
        "",
      ].join("\n"),
    });

    expect(output).toBe(
      [
        'model_instructions_file = "/tmp/repo/AGENTS.CODEX.md"',
        "",
        "[mcp_servers.serena-stdio]",
        'command = "uvx"',
        "",
      ].join("\n"),
    );
  });

  it("removes the managed model_instructions_file key when no guidance file is requested", () => {
    const output = updateCodexConfigContent({
      guidanceFilePath: null,
      rawConfigContent: [
        'model_instructions_file = "/tmp/repo/AGENTS.CODEX.md"',
        "",
        "[mcp_servers.serena-stdio]",
        'command = "uvx"',
        "",
      ].join("\n"),
    });

    expect(output).toBe(
      [
        "[mcp_servers.serena-stdio]",
        'command = "uvx"',
        "",
      ].join("\n"),
    );
  });
});

describe("rewriteWorkspaceAbsolutePathsInTextContent", () => {
  it("rewrites workspace-root absolute paths without touching unrelated paths", () => {
    const sourceWorkspacePath = "/tmp/source-workspace";
    const targetWorkspacePath = "/tmp/target-workspace";
    const output = rewriteWorkspaceAbsolutePathsInTextContent({
      content: [
        'model_instructions_file = "/tmp/source-workspace/AGENTS.CODEX.md"',
        'other_path = "/tmp/source-workspace-two/leave-me-alone"',
        "",
      ].join("\n"),
      sourceWorkspacePath,
      targetWorkspacePath,
    });

    expect(output).toBe(
      [
        'model_instructions_file = "/tmp/target-workspace/AGENTS.CODEX.md"',
        'other_path = "/tmp/source-workspace-two/leave-me-alone"',
        "",
      ].join("\n"),
    );
  });
});

describe("syncAgentsGuidance", () => {
  it("writes the generated Codex guidance file and patches local Codex config", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agents-guidance-"));

    try {
      fs.writeFileSync(path.join(temporaryRoot, "AGENTS.md"), "# Shared\n", "utf8");
      fs.writeFileSync(path.join(temporaryRoot, "CODEX.md"), "# Codex\n", "utf8");
      fs.mkdirSync(path.join(temporaryRoot, ".codex"), { recursive: true });
      fs.writeFileSync(
        path.join(temporaryRoot, ".codex", "config.toml"),
        ['[mcp_servers.serena-stdio]', 'command = "uvx"', ""].join("\n"),
        "utf8",
      );

      const report = syncAgentsGuidance({
        mode: "write",
        repoRoot: temporaryRoot,
        targetIds: ["codex"],
      });

      expect(report.totalErrors).toBe(0);

      const generatedGuidancePath = path.join(temporaryRoot, "AGENTS.CODEX.md");
      const generatedGuidanceContent = fs.readFileSync(generatedGuidancePath, "utf8");
      expect(generatedGuidanceContent).toContain("# Shared");
      expect(generatedGuidanceContent).toContain("# Codex");

      const codexConfigContent = fs.readFileSync(
        path.join(temporaryRoot, ".codex", "config.toml"),
        "utf8",
      );
      expect(codexConfigContent).toContain(
        `model_instructions_file = ${JSON.stringify(generatedGuidancePath)}`,
      );
      expect(codexConfigContent).toContain("[mcp_servers.serena-stdio]");
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("removes generated Codex runtime output and config binding when CODEX.md is absent", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agents-guidance-cleanup-"));

    try {
      const generatedGuidancePath = path.join(temporaryRoot, "AGENTS.CODEX.md");

      fs.writeFileSync(path.join(temporaryRoot, "AGENTS.md"), "# Shared\n", "utf8");
      fs.writeFileSync(generatedGuidancePath, "# stale\n", "utf8");
      fs.mkdirSync(path.join(temporaryRoot, ".codex"), { recursive: true });
      fs.writeFileSync(
        path.join(temporaryRoot, ".codex", "config.toml"),
        [
          `model_instructions_file = ${JSON.stringify(generatedGuidancePath)}`,
          "",
          "[mcp_servers.serena-stdio]",
          'command = "uvx"',
          "",
        ].join("\n"),
        "utf8",
      );

      const report = syncAgentsGuidance({
        mode: "write",
        repoRoot: temporaryRoot,
        targetIds: ["codex"],
      });

      expect(report.totalErrors).toBe(0);
      expect(fs.existsSync(generatedGuidancePath)).toBe(false);

      const codexConfigContent = fs.readFileSync(
        path.join(temporaryRoot, ".codex", "config.toml"),
        "utf8",
      );
      expect(codexConfigContent).not.toContain("model_instructions_file");
      expect(codexConfigContent).toContain("[mcp_servers.serena-stdio]");
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
