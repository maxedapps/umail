import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Agents share the machine, and Vitest's default of a worker per core but one overloads it.
    maxWorkers: 4,
    include: ["*.test.ts", "apps/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.worker.spec.ts", "**/*.browser.spec.ts"],
  },
});
