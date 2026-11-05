import browser from "@playwright/browser-chromium/package.json" with { type: "json" };
import runner from "playwright/package.json" with { type: "json" };
import { expect, it } from "vitest";

it("installs the browser the Playwright runner launches", () => {
  expect(browser.version).toBe(runner.version);
});
