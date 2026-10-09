import { fileURLToPath, URL } from "node:url";

// What every slow suite reaches outside its specs' imports: dependencies, TypeScript settings and the
// API contract (adrs/0007-adaptive-gate.md).
const SHARED = [
  "package.json",
  "apps/server/package.json",
  "packages/api-contract/package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches/**",
  "tsconfig.json",
  "apps/server/tsconfig.json",
  "packages/api-contract/tsconfig.json",
  "packages/api-contract/src/**",
  "tests/rerun-triggers.ts",
];

const ROOT = new URL("../", import.meta.url);

// Vitest's forceRerunTriggers for a slow suite, from repo-relative globs.
export const rerunTriggers = (...globs: Array<string>) =>
  [...SHARED, ...globs].map((glob) => fileURLToPath(new URL(glob, ROOT)));
