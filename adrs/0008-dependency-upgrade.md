# 0008: Upgrade every dependency to its latest release

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

umail pinned Alchemy 2.0.0-beta.77, Effect 4.0.0-rc.112, Better Auth 1.7.2, postal-mime 3.0.0 and Vitest 4.1 with three local patches. Max asked for every dependency at its latest release and for the profile sign-in to keep working with the new Alchemy. The upgrade raised these decisions:

- **Effect 4.0 stable** marks its HTTP, HttpApi, CLI and test modules `@stability unstable`, which `@effect/tsgo`'s `unstable-api-usage` lint rule now reports on every import.
- **Better Auth 1.7.3** dropped `account.issuer`, which 1.7.0–1.7.2 created as `NOT NULL` with the unique index `account_issuer_accountId_uidx`. Every existing umail database has both, so Better Auth's inserts would fail on the column it no longer writes. Its migrations report the column without dropping it.
- **postal-mime 4** is a TypeScript rewrite. It ships `maxPartCount` per parser, keeps line endings as sent, and still buffers decoded parts in a Blob.
- **Alchemy beta.81** already orders ready-stable after the stored output, which the beta.77 patch did. It lacks [PR #1923](https://github.com/alchemy-run/alchemy/pull/1923) (open): a silent OAuth refresh starts from the profile config loaded before the credentials lock, so two processes on one profile, or one long-lived process refreshing twice, spend Cloudflare's single-use refresh token twice and revoke the grant.
- **`@distilled.cloud/cloudflare` rc.13** types `email-routing getDns` as the zone's record list, but with `subdomain` the API answers `{ errors, record }`.

## Decision

- Upgrade every package to its latest release: Alchemy beta.81, Effect 4.0.2, Better Auth 1.7.7, postal-mime 4.0.5, Vitest 5.0.3 and the rest. `@types/node` stays on the latest 24.x to match Node 24, and pnpm stays on 11.13.1.
- Turn `effecttsgo/unstable-api-usage` off: umail is built on those modules.
- `applyAuthSchema` drops `account_issuer_accountId_uidx` and `account.issuer` when the column exists, as Better Auth's 1.7 upgrade guide prescribes for SQLite, before its own migrations. Credential provisioning no longer reads or writes the column.
- Port the postal-mime patch to 4.0.5: parse budgets checked before allocation, `maxPartCount` shared with nested messages so it bounds the whole parse, and decoded chunks joined into one exact buffer (`concatChunks`) instead of a Blob. The 3.0 block accumulators go: 4.0's chunk arrays plus one join keep peak memory at two copies.
- Re-create the Better Auth Cursor redirect patch on 1.7.7 unchanged.
- Drop the Alchemy ready-stable patch and adopt PR #1923 as the Alchemy patch, identical to agentmanager's port (its ADR 0297), with `tests/alchemy-refresh-lock.test.ts`. Agents deploy previews concurrently on Max's one Cloudflare profile, so the race is real here.
- Decode the subdomain `getDns` answer with a local schema instead of trusting the SDK type.

## Alternatives

- **Upgrade only Alchemy.** Smallest, but Alchemy beta.81 needs Effect 4.0 stable, which pulls most of the tree.
- **Keep the issuer column and write a constant.** No migration, but it keeps a column Better Auth no longer knows and code to feed it.
- **Use postal-mime 4 unpatched with its `maxPartCount`.** Loses the decoded-size, line and HTML budgets the inbound path relies on, and a nested message would get a fresh part budget.
- **Wait for PR #1923.** No patch, but a revoked grant on a concurrent deploy means Max signs in again.

## Consequences

- The first deploy after the upgrade drops `account.issuer` from the stage's AuthDb; the prod dry-run shows `AuthProvision` updating, as it does on every deploy.
- Three patches remain, each with a test (`docs/operations.md`, Dependency patches). Delete the Alchemy patch and its test once Alchemy ships PR #1923.
