# ADR 0012: Secrets from agentmanager's vaults

## Status

Accepted.

## Context

umail's deploy, CLI and live checks read their configuration from a private `.env` in the checkout (`--env-file <file>` for a second installation, [ADR 0010](0010-named-installations.md)). agentmanager now keeps each project's variables in Hub vaults, one per project and environment ([agentmanager ADR 0373](https://github.com/maxedapps/agentmanager/blob/main/adrs/0373-secrets.md)): `agents run [--env e] -- <command>` runs a command with the vault of the folder's project, a variable already set by the caller winning, and `agents secrets list|diff` print names only. A worktree then needs no `.env`. Max wants every repo moved to vaults and Infisical and the `.env` files removed (task 1484).

The existing `.env` configures the `uMail` installation. Its `prod` stage and every other stage (`dev`, previews `pr-<n>`, `test-*`) deploy from the same values; the stage only derives subdomains. `UMAIL_LEGACY_CATCH_ALL` acts on `prod` alone (`configureMailRouting`), and `UMAIL_URL` is the prod console the operator CLI talks to.

## Decision

- **Vaults.** `prod` holds what the `uMail` prod stage deploys with plus the operator CLI's `UMAIL_URL` (9 names). `dev` holds what its other stages deploy with: the same minus `UMAIL_LEGACY_CATCH_ALL` and `UMAIL_URL` (7 names; `UMAIL_LEGACY_SEED_RULES` only for a stage's first controller rollout). Both were imported from the `.env` by pipe and checked with `agents secrets diff`.
- **A second installation** gets one vault env named for it, holding its complete configuration (`UMAIL_STACK` included), such as `academind`. The change that first deploys it adds its `deploy:<name>` script (`agents run --env <name> -- alchemy deploy --stage prod`). One vault per installation keeps `UMAIL_STACK` and its credentials together, so the vault chosen selects the installation.
- **Scripts run under `agents run`.** `deploy:stage` (`tools/deploy.sh`) takes the vault of the stage Alchemy deploys: `prod` for the `prod` stage, `dev` for every other, reading `--stage` before `$ALCHEMY_STAGE` as Alchemy does. Vault and target cannot disagree, and the prod command stays `pnpm deploy:stage --stage prod …`. `umail` runs with `prod`. Other Alchemy commands (plan, destroy, logs) name their vault on the command line: `agents run [--env prod] -- pnpm exec alchemy …`; the bare `alchemy` script goes. The gate and test scripts read no secret and stay as they are.
- **The cutover command reads `CF_EMAIL_ROUTING_RULES_TOKEN` from the environment**, as the deploy does, instead of its `--env-file` (default `.env`).
- **`UMAIL_STACK` comes from the process environment alone.** `alchemy.run.ts` reads it before constructing the Stack with Effect's env provider, keeping blanks so a blank cannot fall back to the default installation. A `.env` or `--env-file` never selects the installation, and `.env.example` goes.

## Alternatives

- **Keep `.env` files (the simplest)**: works, but every worktree needs the checkout's file linked in and Max wants them gone.
- **A fixed vault per script (`deploy:stage` with `dev`, a new `deploy:prod` with `prod`)**: simpler, but `pnpm deploy:stage --stage prod` (the documented command until now) or `ALCHEMY_STAGE=prod` would deploy prod with dev's values.
- **`agents run --env <vault> -- pnpm deploy:stage …` around an unwrapped script**: flexible, but every caller must remember the prefix; a forgotten one deploys with whatever the shell has.
- **Nesting `agents run --env prod -- pnpm deploy:stage` around a `dev`-wrapped script**: the inner run fills every name `prod` lacks from `dev`, the same silent fill-in the env-file docs warned about.
- **One vault for all of `uMail`'s stages**: dev and prod are equal today, but `UMAIL_LEGACY_CATCH_ALL` and `UMAIL_URL` are prod-only, and agentmanager's convention (`dev` default, `prod` for deploys) is what other repos and agents expect.

## Consequences

- A deploy, a preview and the CLI need the Hub (and the caller's vault membership); with the Hub down, use Max's offline copy.
- Alchemy still loads a `.env` beside a command (or an `--env-file`) and fills in what the vault lacks, so nobody adds one; it never changes the stack name. `.gitignore` keeps ignoring `.env*` so a stray file holding secrets is never committed.
- Rotating a value means `agents secrets set` (or the app's Secrets page), no longer editing `.env`.
