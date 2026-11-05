# Pinned Playwright browsers plan

The decision is [agent-setup ADR 0027](https://github.com/academind/agent-setup/blob/main/adrs/0027-projects-install-pinned-browsers-with-their-dependencies.md); it leaves no umail decision open.

## Goal

`pnpm install` brings the browsers of the pinned Playwright, so a bump reaches every machine with no hand install and no gate step.

## Non-goals

- Deploying a stage: nothing here reaches one.
- `@playwright/browser-webkit`: umail launches Chromium only.

## Tasks

1. **Workspace.** `@playwright/browser-chromium` in `allowBuilds`, `sideEffectsCache: false` (pnpm 11.13.1 has no `exclude`).
2. **Dependency.** `@playwright/browser-chromium` at the runner's exact version in the root `devDependencies`. The root `playwright` pin stays: it satisfies the required peer of the root `@vitest/browser-playwright`, which keeps one Vitest instance for the gate's root `vitest` bin.
3. **Test.** `apps/server/test/playwright-browser.test.ts` compares the package with `playwright/package.json`, what server tests launch.
4. **Gate and docs.** Delete the gate's `playwright install`; `AGENTS.md` says where browsers come from and that a bump moves every Playwright line together.
5. **Verified by.** A frozen install on a throwaway cache shows `chromium-1248`; `pnpm gate` and the browser suite pass; a scratch runner-only bump turns the gate red on the new test.

## Evidence

Nothing visible changes. The report carries each check's proof and the landed SHA.

## Settled findings
