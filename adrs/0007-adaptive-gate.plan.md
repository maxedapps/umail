# Plan for 0007: A landing gate that scales with the change

- **Status:** Done
- **ADR:** [0007-adaptive-gate.md](0007-adaptive-gate.md)

## Goal

**Done when** `pnpm gate` runs the fast checks whole and selects slow specs by what the change against `main` reaches, AGENTS.md maps the slow suites and names the gate, and `pnpm gate --list` shows the expected selection for a docs, CLI, server and web asset change.

**Out of scope:** changing the suites themselves, CI.

## Tasks

1. **Triggers.** `tests/rerun-triggers.ts` and `forceRerunTriggers: rerunTriggers(...)` in the three slow configs, as the ADR lists them. **Done.**
2. **Gate.** `tools/gate.sh`, `"gate": "tools/gate.sh"`, `--list` for the selection only. Format the five unformatted ADRs once so `oxfmt --check .` passes. **Done.**
3. **Map.** AGENTS.md "Checks": the gate, each slow suite with its specs and the paths that reach it, the rule for new runtime inputs, `pnpm test` as the full run. **Done.**
4. **Verify.** `pnpm gate --list` per scenario in a scratch clone whose `main` is the gate commit, specs selected (root worker / server worker / browser): **Done.**

   | Change                                                                                           | Selected              |
   | ------------------------------------------------------------------------------------------------ | --------------------- |
   | `README.md`, `docs/operations.md`                                                                | 0 / 0 / 0             |
   | `apps/cli/src/runtime.ts`, a Node server test                                                    | 0 / 0 / 0             |
   | `apps/cli/package.json`                                                                          | 0 / 0 / 0             |
   | `apps/server/src/account/jobs.ts`                                                                | 1 / 15 / 2            |
   | `apps/server/src/web/styles.ts`                                                                  | 1 / 0 / 2             |
   | `test/account/jobs.worker.spec.ts`                                                               | 0 / 1 / 0 (that spec) |
   | `test/account/harness.ts`                                                                        | 0 / 11 / 0            |
   | `test/api/world.ts`                                                                              | 0 / 0 / 2             |
   | `apps/server/vitest.worker.config.ts`                                                            | 0 / 15 / 0            |
   | `tsconfig.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, a new patch, `tests/rerun-triggers.ts` | 1 / 15 / 2            |

   A format error stops the gate at the first step with exit 1. The fast checks and the real gate run once on the merged result.

## Evidence

No UI. Key files and snippets, plus the selection table above.

## Open questions

None.
