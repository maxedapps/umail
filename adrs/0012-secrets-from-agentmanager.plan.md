# Plan 0012: Secrets from agentmanager's vaults

ADR: [0012](0012-secrets-from-agentmanager.md). Task 1484.

## Goal

Every umail command that reads configuration gets it from the project's Hub vaults through `agents run`; a worktree needs no `.env`.

Non-goals: removing `.env`, `.env.example`, Infisical or Alchemy's own `--env-file` support; deploying prod or Academind; creating an Academind vault (no `.env.academind` exists).

## Tasks

1. **Vaults (done before the code).** From the main checkout, in `bash -o pipefail`: `agents secrets import --env prod < .env` (9 names) and `.env` without `UMAIL_LEGACY_CATCH_ALL` and `UMAIL_URL` into `dev` (7 names). Verified: `agents secrets diff --env prod < .env` all `same`; `--env dev` `same` except those two `missing`.
2. **Scripts** (`package.json`): `deploy:stage` → `tools/deploy.sh`, which runs `agents run --env <vault> -- agents heavy -- alchemy deploy "$@"` with `prod` for the `prod` stage (`--stage` before `$ALCHEMY_STAGE`) and `dev` otherwise. Tested: `tests/deploy-vault.test.ts` runs it offline with a fake `agents` (fails against the fixed-`dev` script for every prod case); `umail` → `agents run --env prod -- node apps/cli/src/bin.ts`; drop the bare `alchemy` passthrough. `gate`, `test*` unchanged (no secrets).
3. **Cutover token from the environment** (`apps/cli/src/recipient-cutover.ts`, `commands/index.ts`): drop `--env-file`; `cutoverCloudflare` reads `CF_EMAIL_ROUTING_RULES_TOKEN` through the current `ConfigProvider`. Tested: `apps/cli/test/cli.test.ts` cutover case passes the fake token in the CLI's env instead of a file (fails before the change: the flag-less command reads `.env`, which the test directory lacks).
4. **Config error** (`apps/server/src/site.ts`): "is missing. Set it in .env." → names the vault. Tested: `tests/deploy-config.test.ts` expectation.
5. **Docs**: AGENTS.md (Deploy command and bullets, named installations, live checks' `CF_EMAIL_ROUTING_TOKEN`, UI changes' operator sign-in through `agents run`), README (configure, deploy, separate installations, update, CLI `UMAIL_URL`), `docs/operations.md` (named installations, routing credentials, cutover command, private configuration wording); ADR 0010's status notes its env-file part superseded.
6. **Checks.** `pnpm gate` in the worktree (no `.env`). Prod dry-run: `env -u CLOUDFLARE_API_TOKEN pnpm deploy:stage --stage prod --profile mschwarzmueller --dry-run --no-input` against a baseline of the same dry-run with `--env-file <checkout>/.env` taken before the change; the plans must match (expected: only `App/AUTH_OPERATOR_ID` update). `agents run --env dev` / `--env prod` with a node probe printing only which expected names are set.

## Evidence

No UI change: key files and snippets, the two vaults' names and counts, the dry-run comparison.

## Open questions

None.

## Removal (task 1484, part 2)

Max removed the `.env` files and Infisical. Non-goals: a deploy; changing Alchemy's own `.env`/`--env-file` loading.

1. **Stack name from the environment** (`alchemy.run.ts`): read `UMAIL_STACK` with `ConfigProvider.fromEnv({ preserveEmptyStrings: true })` before the Stack; delete `tools/stack-name.ts` with its `--env-file`/`ALCHEMY_EXEC_OPTIONS` parsing and drop it from the root worker suite's rerun triggers. Tested: `tests/stack-name.test.ts` (a `.env` beside the entrypoint never selects the stack, fails against the old resolver; a blank `UMAIL_STACK` errors on one line through the real CLI).
2. **Leftovers**: delete `.env.example` and its `.gitignore` exception (`.env*` stays ignored); AGENTS.md, `docs/operations.md`, ADRs 0005, 0010, 0012 no longer describe `.env` as current.
3. **Checks**: `pnpm gate`.
