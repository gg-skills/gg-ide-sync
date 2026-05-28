/**
 * @fileoverview Jest configuration for the portable IDE sync skill scripts.
 *
 * This file owns the Jest roots, ESM/ts-jest transform wiring, and test match patterns used when
 * running `ide-sync` script unit tests from the repository root.
 *
 * @testing CLI: NODE_OPTIONS='--experimental-vm-modules' npx jest --config skills/ide-sync/jest.config.ts
 * @see skills/ide-sync/scripts/__tests__/ - Jest unit specs for agent, guidance, rule, and workflow sync helpers executed via this config.
 * @documentation reviewed=2026-05-13 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */
import type { Config } from "jest";

const config = {
  rootDir: ".",
  roots: ["<rootDir>/scripts"],
  testEnvironment: "node",
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "<rootDir>/tsconfig.json",
      },
    ],
  },
  testMatch: ["**/scripts/**/*.unit.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/\\.*/"],
  modulePathIgnorePatterns: ["/\\.*/"],
  moduleFileExtensions: ["ts", "js", "json"],
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 10000,
  silent: true,
} satisfies Config;

export default config;
