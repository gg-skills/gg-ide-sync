/**
 * @fileoverview Verifies the agent sync helpers format generated agents for the supported target
 * toolchains.
 *
 * Flow: canonical agent data -> formatter helpers -> output assertions.
 *
 * @testing Jest unit: NODE_OPTIONS='--experimental-vm-modules' npx jest --config skills/ide-sync/jest.config.ts skills/ide-sync/scripts/__tests__/sync-agents-lib.unit.test.ts
 * @see ../canonical-agents/lib.ts - Agent sync helpers under test.
 * @documentation reviewed=2026-04-12 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import { describe, expect, it } from "@jest/globals";

import {
  formatAugmentAgent,
  formatClaudeCodeAgent,
  formatCodexAgent,
  type AgentOverride,
  type AgentGenerationContext,
  type CanonicalAgent,
} from "../canonical-agents/lib";

const canonicalAgent: CanonicalAgent = {
  body: "Follow the instructions.",
  description: "Test agent",
  frontmatter: {
    access: "workspace-write",
    description: "Test agent",
    id: "test-agent",
    mode: "subagent",
    reasoning: "high",
    targets: {
      augment: {
        color: "blue",
        name: "test-agent-augment",
      },
      "claude-code": {
        model: "sonnet",
      },
      codex: {
        model: "o3",
      },
    },
  },
  id: "test-agent",
  mode: "subagent",
  source: "subagents",
};

describe("formatCodexAgent", () => {
  it("renders portable canonical metadata into the generated TOML", () => {
    const output = formatCodexAgent(canonicalAgent);

    expect(output).toContain('model = "o3"');
    expect(output).toContain('model_reasoning_effort = "high"');
    expect(output).toContain('sandbox_mode = "workspace-write"');
  });

  it("rejects unsupported sandbox modes", () => {
    const override: AgentOverride = {
      agentId: canonicalAgent.id,
      frontmatter: {
        sandbox_mode: "container",
      },
    };

    expect(() => formatCodexAgent(canonicalAgent, override)).toThrow(
      'Invalid Codex sandbox_mode for test-agent: "container". Expected one of read-only, workspace-write, danger-full-access.',
    );
  });

  it("adds fallback semantic code search guidance when the workstation has no semantic MCP", () => {
    const context: AgentGenerationContext = {
      semanticCodeSearch: {
        fallback: "rg",
        kind: "fallback",
      },
    };
    const semanticAgent: CanonicalAgent = {
      ...canonicalAgent,
      frontmatter: {
        ...canonicalAgent.frontmatter,
        tools: ["read", "semantic-code-search"],
      },
      tools: ["read", "semantic-code-search"],
    };

    const output = formatCodexAgent(semanticAgent, undefined, context);

    expect(output).toContain("No semantic MCP is configured for this workstation.");
    expect(output).toContain("Use `rg`, `grep`, `glob`, and direct file reads for code discovery.");
  });
});

describe("formatClaudeCodeAgent", () => {
  it("maps canonical approval and reasoning metadata into Claude Code fields", () => {
    const approvalAgent: CanonicalAgent = {
      ...canonicalAgent,
      frontmatter: {
        ...canonicalAgent.frontmatter,
        approvalFlow: "plan",
      },
    };

    const output = formatClaudeCodeAgent(approvalAgent);

    expect(output).toContain("model: sonnet");
    expect(output).toContain("effort: high");
    expect(output).toContain("permissionMode: plan");
  });

  it("resolves semantic-code-search into the workstation semantic tool", () => {
    const context: AgentGenerationContext = {
      semanticCodeSearch: {
        fallback: "rg",
        guidanceLabel: "Augment codebase retrieval",
        kind: "provider",
        toolName: "codebase-retrieval",
      },
    };
    const semanticAgent: CanonicalAgent = {
      ...canonicalAgent,
      frontmatter: {
        ...canonicalAgent.frontmatter,
        tools: ["read", "semantic-code-search"],
      },
      tools: ["read", "semantic-code-search"],
    };

    const output = formatClaudeCodeAgent(semanticAgent, undefined, context);

    expect(output).toContain("- codebase-retrieval");
    expect(output).not.toContain("semantic-code-search");
    expect(output).toContain("Prefer `codebase-retrieval` for semantic codebase discovery on this workstation.");
  });
});

describe("formatAugmentAgent", () => {
  it("uses canonical target metadata for Augment-specific output fields", () => {
    const output = formatAugmentAgent(canonicalAgent);

    expect(output).toContain("name: test-agent-augment");
    expect(output).toContain("color: blue");
  });
});
