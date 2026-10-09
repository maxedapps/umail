import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { rerunTriggers } from "../../tests/rerun-triggers.ts";

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
    // The pages come from the fixture plugin's in-memory app, which the specs don't import.
    forceRerunTriggers: rerunTriggers(
      "apps/server/vitest.browser.config.ts",
      "apps/server/src/**",
      "apps/server/test/web/web-pages-browser-*.ts",
      "apps/server/test/api/!(*.test).ts",
    ),
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      commands: webPageBrowserCommands,
    },
  },
});
