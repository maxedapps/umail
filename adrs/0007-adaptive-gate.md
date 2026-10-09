# 0007: A landing gate that scales with the change

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

The shared agent rules (task 590) require one gate per repo that runs the fast checks whole and only the slow tests a change reaches, with a map of the slow suites in AGENTS.md. umail had no gate: `pnpm test` ran the Node tests, both workerd passes and Chromium on every change, and nothing checked formatting.

The slow suites, all Vitest projects:

- **root worker** (`vitest.worker.config.ts`): `tests/runtime-startup.worker.spec.ts` against the App worker that the config bundles from `alchemy.run.ts`.
- **server worker** (`apps/server/vitest.worker.config.ts`): the `*.worker.spec.ts` files against the Durable Object host `test/account/worker-host.ts`.
- **browser** (`apps/server/vitest.browser.config.ts`): two Chromium specs. `web-pages` drives pages that the config's `webPageBrowserFixture` plugin serves from the in-memory app world.

Each reaches most server code at runtime (a bundle, a worker `main`, a config plugin), not through the specs' imports. The server worker specs import the host only as a type, which the transform erases.

Vitest 4.1's `--changed <ref>` diffs `<ref>...HEAD` plus staged, unstaged and untracked files, runs the specs whose static import graph contains a changed file, and runs the whole project when a changed file matches `forceRerunTriggers`. With `--changed`, `passWithNoTests` defaults to true.

The Node tests (`vitest run`) take about 20 s, including the client build and the CLI process tests, so they stay a fast check.

## Decision

- `pnpm gate` (`tools/gate.sh`) runs, failing fast: `oxfmt --check .`, `pnpm lint`, `pnpm typecheck`, `vitest run`, then each slow suite with `vitest run --changed main`. `pnpm gate --list` runs `vitest list --filesOnly --changed main` per slow suite instead and nothing else.
- Each slow config sets `forceRerunTriggers` to its runtime reach through `rerunTriggers(...)` (`tests/rerun-triggers.ts`), which turns repo-relative globs into absolute ones and adds what every suite reaches: the root, server and contract manifests and tsconfigs, the lockfile, `pnpm-workspace.yaml`, `patches/**`, `packages/api-contract/src/**` and the helper itself. Per suite:
  - root worker: its config, `alchemy.run.ts`, `apps/server/src/**`, `tests/stack-fixture.ts`, `tests/worker-bundle.ts`;
  - server worker: its config, the host and `apps/server/src/` except `api/` and `web/`, which the host doesn't import;
  - browser: its config, `apps/server/src/**`, the fixture and the `test/api` helpers it builds the world from.
- They replace Vitest's default triggers (any `package.json` or `vitest.config.*`), which would run every slow suite for a CLI manifest or Node config change.
- Everything else reaches a slow spec through its imports, so Vitest selects single specs: a changed spec or spec helper runs alone.
- The repo is formatted whole once, so the format check can run whole.
- `pnpm test` stays as the full run for when a person asks for one.

## Alternatives

- **A path map in the gate script, running whole suites.** Simplest, but a changed spec runs its whole suite, and the map would duplicate what Vitest's import graph already knows.
- **Computing each runtime entry's import graph** (host, fixture, bundle) to derive the triggers. Precise, but extra machinery for a gain of a directory or two.
- **`vitest --changed` without triggers.** Misses most server changes, since the suites reach them at runtime.
- **Formatting only the changed files.** Needed while five ADRs were unformatted; formatting them once is simpler than a changed-file list.
- **Moving the client build and CLI process tests to the slow map.** They cost seconds; a map for them would cost more than it saves.

## Consequences

- A docs, CLI or Node-test change runs no slow spec. A server change runs all three suites. A change only to `src/web` or `src/api` skips the server worker suite.
- A new runtime input (an import from the Durable Object host into `src/api` or `src/web`, a new fixture plugin) must be added to the suite's triggers. AGENTS.md says so next to the map.
- Each slow suite still loads its config on every gate: the root worker config bundles the App worker (about 6 s) even when it selects nothing.
