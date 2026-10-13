# Flake ledger

Tests that failed in a gate run and passed alone, one line each ([awesome-tests](https://github.com/academind/agent-setup/blob/main/skills/awesome-tests/SKILL.md#flaky-tests)). `pnpm gate` appends the line; replace its `cause: ?` with your suspected cause and commit it with the fix or the skip.

- 2026-10-13 task-931 `tests/runtime-startup.worker.spec.ts > generated application runtime > initializes the real AccountStore schema and seeds preview mailboxes once across eviction` — `AssertionError: expected false to be true // Object.is equality` — cause: Miniflare may already have consumed the alarm and be processing its HTTP work, so the manual alarm helper returns before that work commits. The test now waits for committed seed routing; alarm scheduling remains covered separately.
