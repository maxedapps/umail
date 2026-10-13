# Plan 0010: Named installation selection (task 931)

## Goal and non-goals

Select independent Alchemy stacks from one repository using private installation env files, preserving `uMail/prod`. Land on main without deploying. Per-install routing is deferred under the task's explicit stop condition: preserving runtime mailbox creation without a zone catch-all requires the larger controller design.

No new mail domains, DNS writes, migrations, UI changes, sending capabilities or live deploys.

## Tasks

1. Review ADR 0010 and this plan with the build-feature reviewer; settle findings and accept the ADR.
2. Add validated `UMAIL_STACK` in `apps/server/src/site.ts`, defaulting only an absent variable to `uMail`. Resolve identity before `Alchemy.Stack` using Effect's env/dotenv providers with `preserveEmptyStrings: true`, the CLI's precedence and `--env-file` selection; preserve resource IDs and application wiring.
3. Test the actual entrypoint's metadata with default, selected and invalid config in isolated Node processes. Verify selected-file precedence, identity case preservation, one-line config errors and unchanged existing resource graph. Use no live provider calls. Prove the selection test fails against the hardcoded stack.
4. Document `.env`/`--env-file`, explicit existing identity, independent `prod` stacks, typo/new-state behavior and the routing limitation in `.env.example`, README, operations and AGENTS. Do not present Academind as deploy-ready.
5. Run the scoped landing gate once on the final tree, with logs in `~/tmp`. The existing map selects root startup, server worker and browser suites for the changed entrypoint/site; obtain the required approval for the whole selections before running. Manually inspect the actual CLI's config error output and stack metadata under both env-file choices.
6. Run `env -u CLOUDFLARE_API_TOKEN pnpm deploy:stage --stage prod --profile mschwarzmueller --dry-run --no-input` in the worktree. Inspect the plan against existing `uMail/prod`; expect no routing/resource changes and only the usual auth action update. Skip cloud proof if expired credentials cannot renew, and record that it must run before any deploy.
7. Get code review with commit, check results and logs; settle findings, sync, land and fast-forward main. Close the reviewer, remove the landed task worktree/branch and task scratch. Report the landed SHA, evidence and the runtime-routing vs deploy-defined-mailbox decision for Max.

## Evidence

No UI changes. The report contains exact landed snippets from site config and stack entrypoint, key file links, local selection/error observations, gate results and the prod dry-run result (or authentication failure). No screenshots or video needed.

## Open questions

After step 1 lands, Max chooses whether to authorize the 5–9 day automatic recipient controller (preserves console/CLI creation) or the 3–5 day deploy-defined inbox workflow. Both need the supported child-only receiving prerequisite before native Academind deployment.

## Progress

- Read task inbox and the combined analysis; inspected current Cloudflare docs and installed/current Alchemy routing source. The task's routing stop condition applies.
- Worktree created from `origin/main` at `b7089a4` with pinned dependencies installed.
- Plan review accepted with one fix: Alchemy's dotenv loader drops blank values, so stack identity uses Effect providers that preserve them. The ADR is accepted. Whole mapped gate approval requested; implementation proceeds with focused checks while waiting.
- Implemented stack validation and import-time file selection; documented independent installations and the routing prerequisite. Real entrypoint/CLI tests pass. The selection test rejects a temporary hardcoded `uMail` regression.
- Max approved the mapped gate for this task. Initial prod dry-run refreshed authentication and succeeded: only `App`/`AUTH_OPERATOR_ID` update with `AuthProvision` run, every other binding/resource including routing noop. Final-tree proof and gate follow.
- Gate at `02596c4` passed: 454 Node, 4 root startup, 150 server worker and 22 browser tests. A final integration check found `alchemy dev` forwards `--env-file` to its exec child through typed `ALCHEMY_EXEC_OPTIONS`; stack selection now reads that supported wire format too, with a metadata-only regression (no dev server/stage started).
