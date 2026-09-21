import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { localTargetBrowserFixture, localTargetCommands } from "./tests/redesign-e2e-fixture.ts";

export default defineConfig({
  plugins: [localTargetBrowserFixture()],
  test: {
    include: ["tests/redesign-e2e.browser.spec.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      commands: localTargetCommands,
    },
  },
});
