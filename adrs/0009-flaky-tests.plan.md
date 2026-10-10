# Plan for 0009: Flaky tests (task 636)

- **Status:** In progress
- **Rules:** [awesome-tests](https://github.com/academind/agent-setup/blob/main/skills/awesome-tests/SKILL.md#flaky-tests), from Max's decisions in task 636: the gate reruns a red test alone and logs it but stays red; a skip expires after 14 days with one task per skip; agents run the full suites from time to time at their judgement; live checks stay out of the gate.

## Goal

**Done when** every suite runs at most 4 Vitest workers, every heavy script waits for headroom through `agents heavy`, `pnpm gate` reruns each failing test alone once and logs a pass alone in the flake ledger while staying red, a skip that doesn't lapse within 14 days fails the gate, and AGENTS.md states these rules.

**Out of scope:** retries, a scheduled full run, changing the suites' specs.

## Tasks

1. **Worker cap.** `maxWorkers: 4` in the Node and both workerd configs; the browser suite already runs one file at a time (`fileParallelism: false`). Verify: the suites pass.
2. **Heavy scripts.** `agents heavy --` in `gate`, both `test:worker` scripts and `test:browser`, and in one `deploy:stage` script that replaces the unused `deploy:dev` and `deploy:prod` (they lack the profile, so they hit the wrong account). Verify: `pnpm gate` runs under it.
3. **Lone rerun.** `tools/gate.sh` runs each suite with Vitest's JSON report; on red, `tools/rerun-alone.ts` reruns each failing test alone in its own process (`-t` on its exact name) and appends a pass alone to `flakes.md` at the root (`merge=union`); the gate exits 1 either way. Verify: an order-dependent test (also in a nested `describe`) gets a ledger line, an always-red test is reported as failing alone.
4. **Skips.** A skip lapses by itself: `skipIf` on the real clock, marked `// flaky: task-<n> until <date>`. `tests/skips.test.ts` fails on any other skip, on a condition whose date differs from the marker's and on one that runs past 14 days. Verify: temporary unconditional, always-true, unmarked, mismatched, too long, lapsed and valid skips.
5. **Live checks.** None in the gate: the Node tests evaluate the stack with a client that dies on any network request, the workerd and browser suites run on Miniflare and in-memory fixtures. Nothing to move.
6. **Overflow test.** "avoids horizontal overflow at 320px…" passes alone on main 0868705; the cause (an unwrappable requester line) was fixed in ce5ea35 (task 590). Nothing to fix.
7. **AGENTS.md.** Checks: link awesome-tests; worker cap, the lone rerun and ledger, skips, full runs at the agent's judgement, live checks out of the gate; Deploy: `pnpm deploy:stage`.
