/**
 * @fileoverview Regression coverage for generated npm workflow shortcut safety notices.
 *
 * Flow: root npm script name -> generated workflow body -> operator-facing mutation warning.
 *
 * @testing Jest unit: NODE_OPTIONS='--experimental-vm-modules' npx jest --config skills/ide-sync/jest.config.ts skills/ide-sync/scripts/__tests__/workflows-npm.unit.test.ts
 * @see ../canonical-workflows/sync-npm.ts - NPM workflow shortcut generator under test.
 * @documentation reviewed=2026-05-19 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { describe, expect, it } from "@jest/globals";

import {
  buildNpmWorkflowCommand,
  buildNpmWorkflowSafetyNotice,
} from "../canonical-workflows/sync-npm";

describe("buildNpmWorkflowSafetyNotice", () => {
  it("renders explicit dry-run guidance for host-mutating local-edge scripts", () => {
    expect(buildNpmWorkflowSafetyNotice("local:edge:tls:trust")).toContain(
      "bash ./scripts/local-edge/tls-trust.sh --dry-run",
    );
    expect(
      buildNpmWorkflowSafetyNotice("local:edge:split-dns:apply"),
    ).toContain("bash ./scripts/local-edge/split-dns-apply.sh");
    expect(
      buildNpmWorkflowSafetyNotice("local:edge:tailscale:reset"),
    ).toContain("tailscale-reset-services.sh");
  });

  it("classifies runtime and artifact mutation families", () => {
    expect(buildNpmWorkflowSafetyNotice("local")).toContain("Runtime mutation");
    expect(buildNpmWorkflowSafetyNotice("local:edge:stop")).toContain(
      "stops local-edge",
    );
    expect(buildNpmWorkflowSafetyNotice("env:workspace:check")).toContain(
      "Filesystem mutation",
    );
  });

  it("omits the section for read-only representative scripts", () => {
    expect(buildNpmWorkflowSafetyNotice("local:edge:status")).toBe("");
    expect(buildNpmWorkflowSafetyNotice("local-edge-core:test")).toBe("");
  });
});

describe("buildNpmWorkflowCommand", () => {
  it("embeds safety notices before command details without changing the command body", () => {
    const command = buildNpmWorkflowCommand(
      "local:edge:tls:trust",
      "bash ./scripts/local-edge/tls-trust.sh",
      false,
    );

    expect(command.workflowContent).toContain("## Safety Notice");
    expect(command.workflowContent).toContain("Host trust-store mutation");
    expect(command.workflowContent).toContain(
      "bash ./scripts/local-edge/tls-trust.sh --dry-run",
    );
    expect(command.workflowContent).toContain(
      "bash ./scripts/local-edge/tls-trust.sh",
    );
  });
});
