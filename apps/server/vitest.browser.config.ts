import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import {
  webPageBrowserCommands,
  webPageBrowserFixture,
} from "./test/web/web-pages-browser-fixture.ts";

export default defineConfig({
  plugins: [webPageBrowserFixture()],
  // Pre-bundled so a cold cache does not reload the page while the specs import it.
  optimizeDeps: { include: ["@effect/vitest"] },
  test: {
    include: ["test/web/web-pages.browser.spec.ts", "test/mail/html-semantics.browser.spec.ts"],
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      commands: webPageBrowserCommands,
    },
  },
});
