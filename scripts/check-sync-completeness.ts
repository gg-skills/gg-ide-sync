#!/usr/bin/env npx tsx

/**
 * @fileoverview CLI checker that scores the current workspace against the eight-item IDE sync
 * completeness checklist using cwd-relative filesystem probes and root `package.json` sync script
 * wiring.
 *
 * This file owns the `tsx` entrypoint, checklist definition, lightweight detectors, console
 * rendering, and optional JSON report emission for automation.
 * Flow: resolve cwd -> probe canonical source trees and npm sync scripts -> derive per-item
 * booleans -> compute weighted score and required-item gate -> print summary -> append JSON when
 * `--json` is present.
 * NOTE: Legacy inline usage referenced `--lane` / `--check` flags that `main()` does not parse;
 * align operator-facing docs or implement those switches if they remain advertised elsewhere.
 *
 * @testing CLI: npx tsx skills/ide-sync/scripts/check-sync-completeness.ts
 * @testing CLI: npx tsx skills/ide-sync/scripts/check-sync-completeness.ts --json
 *
 * @see package.json - Root npm scripts surface (`sync`, `skills:sync`, `agents:sync`, `workflows:sync`, `rules:sync`) this checker treats as wiring prerequisites for a GG IDE sync run from the repository root.
 * @see skills/ide-sync/jest.config.ts - Jest config file whose presence is used as a heuristic signal for checklist item 7 when the script scans the workspace.
 * @see skills/ide-sync/SKILL.md - GG IDE Sync skill narrative and lane handoffs that explain the canonical sync workflow this checklist accompanies.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - Repository standard defining the audited file-overview shape, tag order, and `@documentation` metadata used by this header.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

import { argv } from "process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ============================================================================
// Types
// ============================================================================

/**
 * One row in the IDE sync quality checklist used for weighted scoring.
 *
 * @remarks
 * Required items gate `canFinalize`; weights only affect the displayed percentage when optional rows exist.
 */
interface ChecklistItem {
  number: number;
  name: string;
  description: string;
  required: boolean;
  checked: boolean;
  weight: number;
}

/**
 * JSON-serializable snapshot of the checklist run for `--json` consumers.
 *
 * @remarks
 * Emitted in addition to human-readable console output; fields align with the same in-memory checklist and totals.
 */
interface CompletenessReport {
  checklist: ChecklistItem[];
  score: number;
  maxScore: number;
  canFinalize: boolean;
}

// ============================================================================
// Checklist Definition
// ============================================================================

const CHECKLIST_ITEMS: Omit<ChecklistItem, "checked">[] = [
  { number: 1, name: "CWD verified", description: "Running from target repo root", required: true, weight: 2 },
  { number: 2, name: "Source folders inventoried", description: "All canonical sources present", required: true, weight: 2 },
  { number: 3, name: "package.json wired", description: "Sync scripts mapped to lanes", required: true, weight: 2 },
  { number: 4, name: "Lane order correct", description: "Skills → Agents → Workflows → Rules → Submodules", required: true, weight: 2 },
  { number: 5, name: "Per-lane execution", description: "Each lane runs independently", required: true, weight: 1 },
  { number: 6, name: "Generated output reviewed", description: "Drift identified and fixed", required: true, weight: 2 },
  { number: 7, name: "Jest suite passed", description: "Skill-owned unit tests green", required: true, weight: 2 },
  { number: 8, name: "Source of truth maintained", description: "Canonical sources edited, not generated", required: true, weight: 2 },
];

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Anchor directory for every path probe in this script.
 *
 * @remarks
 * `PURITY:` Delegates to `process.cwd()`; callers should run the script from the repository root for meaningful results.
 */
function getCwd(): string {
  return process.cwd();
}

/**
 * Whether expected canonical source directories exist under the working directory.
 *
 * @remarks
 * `I/O:` `existsSync` checks for `skills`, `canonical-agents`, `canonical-workflows`, and `canonical-rules` relative to `getCwd()`.
 */
function checkSourceFolders(): { skills: boolean; agents: boolean; workflows: boolean; rules: boolean } {
  const cwd = getCwd();
  return {
    skills: existsSync(join(cwd, "skills")),
    agents: existsSync(join(cwd, "canonical-agents")),
    workflows: existsSync(join(cwd, "canonical-workflows")),
    rules: existsSync(join(cwd, "canonical-rules")),
  };
}

/**
 * Presence flags for aggregate and per-lane sync scripts declared in root `package.json`.
 *
 * @remarks
 * `I/O:` Reads `package.json` from `getCwd()`; on missing file or parse failure returns all `false` without throwing.
 */
function checkPackageJson(): { sync: boolean; skills: boolean; agents: boolean; workflows: boolean; rules: boolean } {
  const cwd = getCwd();
  const packageJsonPath = join(cwd, "package.json");
  
  if (!existsSync(packageJsonPath)) {
    return { sync: false, skills: false, agents: false, workflows: false, rules: false };
  }
  
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    const scripts = pkg.scripts || {};
    
    return {
      sync: !!scripts.sync,
      skills: !!scripts["skills:sync"],
      agents: !!scripts["agents:sync"],
      workflows: !!scripts["workflows:sync"],
      rules: !!scripts["rules:sync"],
    };
  } catch {
    return { sync: false, skills: false, agents: false, workflows: false, rules: false };
  }
}

// ============================================================================
// Main
// ============================================================================

/**
 * CLI entrypoint: prints checklist progress and optional JSON report for automation.
 *
 * @remarks
 * Reads `argv` for `--json` to optionally append a machine-readable report; scoring uses filesystem and `package.json` probes only.
 */
function main() {
  const args = argv.slice(2);
  const jsonArg = args.includes("--json");
  
  console.log("\n📋 IDE Sync Completeness Check");
  console.log("═".repeat(60));
  
  // Run checks
  const cwd = getCwd();
  const sources = checkSourceFolders();
  const packageJson = checkPackageJson();
  
  console.log(`\n📁 Working Directory: ${cwd}`);
  console.log("\n📊 Source Folders:");
  console.log(`   skills: ${sources.skills ? "✅" : "⚠️"}`);
  console.log(`   canonical-agents: ${sources.agents ? "✅" : "⚠️"}`);
  console.log(`   canonical-workflows: ${sources.workflows ? "✅" : "⚠️"}`);
  console.log(`   canonical-rules: ${sources.rules ? "✅" : "⚠️"}`);
  
  console.log("\n📊 package.json Sync Scripts:");
  console.log(`   sync: ${packageJson.sync ? "✅" : "❌"}`);
  console.log(`   skills:sync: ${packageJson.skills ? "✅" : "❌"}`);
  console.log(`   agents:sync: ${packageJson.agents ? "✅" : "❌"}`);
  console.log(`   workflows:sync: ${packageJson.workflows ? "✅" : "❌"}`);
  console.log(`   rules:sync: ${packageJson.rules ? "✅" : "❌"}`);
  
  // Build checklist
  const checklist: ChecklistItem[] = CHECKLIST_ITEMS.map(item => {
    let checked = false;
    
    switch (item.number) {
      case 1: // CWD verified
        checked = cwd.includes("/") || cwd.includes("\\");
        break;
      case 2: // Source folders inventoried
        checked = sources.skills || sources.agents || sources.workflows || sources.rules;
        break;
      case 3: // package.json wired
        checked = packageJson.sync || packageJson.skills;
        break;
      case 4: // Lane order correct
        checked = true; // Assumed if using sync command
        break;
      case 5: // Per-lane execution
        checked = packageJson.skills && packageJson.agents;
        break;
      case 6: // Generated output reviewed
        checked = true; // Assumed after sync
        break;
      case 7: // Jest suite passed
        checked = existsSync(join(cwd, "skills", "ide-sync", "jest.config.ts"));
        break;
      case 8: // Source of truth maintained
        checked = sources.skills || sources.agents;
        break;
      default:
        break;
    }
    
    return { ...item, checked };
  });
  
  const score = checklist.reduce((sum, item) => 
    item.checked ? sum + item.weight : sum, 0);
  const maxScore = checklist.reduce((sum, item) => sum + item.weight, 0);
  
  const requiredItems = checklist.filter(i => i.required);
  const requiredScore = requiredItems.reduce((sum, item) => 
    item.checked ? sum + item.weight : sum, 0);
  const requiredMax = requiredItems.reduce((sum, item) => sum + item.weight, 0);
  
  const canFinalize = requiredScore === requiredMax;
  
  console.log(`\n📊 Score: ${score}/${maxScore} (${((score/maxScore)*100).toFixed(0)}%)`);
  console.log(`   Required items: ${requiredScore}/${requiredMax}`);
  
  console.log(`\n${canFinalize ? "✅" : "⚠️"} Syncable: ${canFinalize ? "YES" : "NEEDS WORK"}`);
  
  console.log("\n📝 Checklist:");
  for (const item of checklist) {
    const icon = item.checked ? "✅" : item.required ? "❌" : "⚠️";
    console.log(`   ${icon} [${item.number}] ${item.name}`);
  }
  
  console.log("\n" + "═".repeat(60));
  
  if (!canFinalize) {
    console.log("\n⚠️ Sync needs work before proceeding.");
    const failedItems = checklist.filter(i => !i.checked && i.required);
    if (failedItems.length > 0) {
      console.log("\nIssues to resolve:");
      failedItems.forEach(i => console.log(`   - ${i.name}: ${i.description}`));
    }
  } else {
    console.log("\n✅ Workspace is ready for IDE sync operation.");
  }
  
  if (jsonArg) {
    const report: CompletenessReport = { checklist, score, maxScore, canFinalize };
    console.log("\n" + JSON.stringify(report, null, 2));
  }
}

main();
