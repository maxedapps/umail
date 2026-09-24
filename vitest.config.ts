import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["*.test.ts", "apps/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.worker.spec.ts", "**/*.browser.spec.ts"],
  },
});
