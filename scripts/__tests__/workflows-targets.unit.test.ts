/**
 * @fileoverview Regression coverage for workflow target cleanup races and deletion filters.
 *
 * Flow: target directory markdown files -> generated/manual cleanup helpers -> idempotent removal.
 *
 * @testing Jest unit: NODE_OPTIONS='--experimental-vm-modules' npx jest --config skills/ide-sync/jest.config.ts skills/ide-sync/scripts/__tests__/workflows-targets.unit.test.ts
 * @see ../canonical-workflows/targets.ts - Cleanup helpers under test.
 * @documentation reviewed=2026-04-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, jest } from "@jest/globals";

import {
  clearManualMarkdownFiles,
  clearPrefixedMarkdownFiles,
  DEFAULT_MIRROR_AUTO_EXECUTION_MODE,
  ensureMirrorAutoExecutionMode,
} from "../canonical-workflows/targets";

const workflowTargetTestTempRoots = new Set<string>();

/**
 * Creates a temp directory for a single test case and registers it for teardown.
 *
 * @remarks
 * I/O: sync mkdir under the OS temp base; path is appended to `workflowTargetTestTempRoots` so
 * `afterEach` removes it recursively.
 *
 * @returns Absolute path to the new empty directory.
 */
function workflowTargetsCreateTempDirectory(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-targets-"));
  workflowTargetTestTempRoots.add(tempRoot);
  return tempRoot;
}

/**
 * Logger stub for target cleanup helpers under test.
 *
 * @remarks
 * PURITY: no side effects; avoids console noise while satisfying the cleanup helpers' log hooks.
 */
function workflowTargetsNoopLog(): void {}

afterEach(() => {
  jest.restoreAllMocks();

  for (const tempRoot of workflowTargetTestTempRoots) {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
  workflowTargetTestTempRoots.clear();
});

describe("workflow target cleanup", () => {
  it("tolerates prefixed markdown files disappearing during cleanup", () => {
    const directory = workflowTargetsCreateTempDirectory();
    const stalePath = path.join(directory, "npm-run-stale.md");
    const preservedPath = path.join(directory, "manual-workflow.md");
    fs.writeFileSync(stalePath, "stale\n", "utf8");
    fs.writeFileSync(preservedPath, "manual\n", "utf8");

    const originalRmSync = fs.rmSync;
    let simulatedRace = false;
    jest.spyOn(fs, "rmSync").mockImplementation((targetPath, options) => {
      if (
        !simulatedRace &&
        typeof targetPath === "string" &&
        targetPath === stalePath
      ) {
        simulatedRace = true;
        originalRmSync(targetPath, { force: true });
      }

      originalRmSync(targetPath, options);
    });

    expect(() =>
      clearPrefixedMarkdownFiles(directory, ["npm-run-"], workflowTargetsNoopLog),
    ).not.toThrow();
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(preservedPath)).toBe(true);
  });

  it("tolerates manual markdown files disappearing during cleanup", () => {
    const directory = workflowTargetsCreateTempDirectory();
    const stalePath = path.join(directory, "manual-workflow.md");
    const preservedPath = path.join(directory, "run-npm-preserved.md");
    fs.writeFileSync(stalePath, "manual\n", "utf8");
    fs.writeFileSync(preservedPath, "generated\n", "utf8");

    const originalRmSync = fs.rmSync;
    let simulatedRace = false;
    jest.spyOn(fs, "rmSync").mockImplementation((targetPath, options) => {
      if (
        !simulatedRace &&
        typeof targetPath === "string" &&
        targetPath === stalePath
      ) {
        simulatedRace = true;
        originalRmSync(targetPath, { force: true });
      }

      originalRmSync(targetPath, options);
    });

    expect(() => clearManualMarkdownFiles(directory, workflowTargetsNoopLog)).not.toThrow();
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(preservedPath)).toBe(true);
  });
});

describe("ensureMirrorAutoExecutionMode", () => {
  const stubCommand = {
    name: "test-workflow",
    description: "A test workflow",
    source: "workflow",
    workflowContent: "",
  };

  it("preserves existing auto_execution_mode when present", () => {
    const input = `---\ndescription: "existing"\nauto_execution_mode: 3\n---\n\nBody text\n`;
    const result = ensureMirrorAutoExecutionMode(input, stubCommand);
    expect(result).toBe(input);
    expect(result).toContain("auto_execution_mode: 3");
    expect((result.match(/auto_execution_mode/g) ?? []).length).toBe(1);
  });

  it("injects auto_execution_mode when frontmatter exists but field is missing", () => {
    const input = `---\ndescription: "existing"\n---\n\nBody text\n`;
    const result = ensureMirrorAutoExecutionMode(input, stubCommand);
    expect(result).toContain(`auto_execution_mode: ${DEFAULT_MIRROR_AUTO_EXECUTION_MODE}`);
    expect(result).toContain('description: "existing"');
    expect(result).toContain("Body text");
  });

  it("creates frontmatter with auto_execution_mode when none present", () => {
    const input = "# My Workflow\n\nBody text\n";
    const result = ensureMirrorAutoExecutionMode(input, stubCommand);
    expect(result).toContain(`auto_execution_mode: ${DEFAULT_MIRROR_AUTO_EXECUTION_MODE}`);
    expect(result).toContain("description:");
    expect(result).toContain("# My Workflow");
    expect(result).toMatch(/^---\n/);
  });
});
