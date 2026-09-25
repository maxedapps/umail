import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import {
  humanPageBrowserCommands,
  humanPageBrowserFixture,
} from "./test/api/human-pages-browser-fixture.ts";

export default defineConfig({
  plugins: [humanPageBrowserFixture()],
  // Pre-bundled so a cold cache does not reload the page while the specs import it.
  optimizeDeps: { include: ["@effect/vitest"] },
  test: {
    include: ["test/api/human-pages.browser.spec.ts", "test/mail/html-semantics.browser.spec.ts"],
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      commands: humanPageBrowserCommands,
    },
  },
});
