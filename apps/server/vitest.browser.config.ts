import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import {
  humanPageBrowserCommands,
  humanPageBrowserFixture,
} from "./test/api/human-pages-browser-fixture.ts";

export default defineConfig({
  plugins: [humanPageBrowserFixture()],
  test: {
    include: ["test/api/human-pages.browser.spec.ts"],
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
