# Plan for 0008: Upgrade every dependency to its latest release

- **Status:** Done
- **ADR:** [0008-dependency-upgrade.md](0008-dependency-upgrade.md)

## Goal

**Done when** `pnpm outdated -r` lists only `@types/node` (held at 24.x), the fast checks and `pnpm gate` pass, and `alchemy profile refresh` for Cloudflare reaches the OAuth step.

**Out of scope:** deploying, preview stages, completing the sign-in, pnpm 12.

## Tasks

1. **Versions.** Bump every workspace manifest, the `pnpm-workspace.yaml` overrides and the lockfile with pnpm. **Done.**
2. **Effect 4.0.2.** Stable import paths and constructors across server, CLI and tests; the lint rule off. **Done.**
3. **Better Auth 1.7.7.** Drop `account.issuer` in `applyAuthSchema`; provisioning without it; a test that provisions a 1.7.2-shaped database and signs in. The loopback near-miss test varies the path, since RFC 8252 lets the port vary. **Done.**
4. **Patches.** Re-create the oauth-provider patch; port the postal-mime patch, with base64 decoded into blocks and nested message roots charged to the shared part count, and update the decoder tests to 4.0's line endings; adopt PR #1923 for Alchemy with its test, checked to fail on unpatched beta.81. **Done.**
5. **Routing.** Decode the subdomain `getDns` answer. **Done.**
6. **Docs.** The patch table in `docs/operations.md`. **Done.**
7. **Verify.** Format, lint, types, Node tests, the Oxc load of `alchemy.run.ts`, `pnpm gate` (the lockfile runs every slow suite), and `alchemy profile refresh --profile mschwarzmueller --provider Cloudflare` up to the OAuth URL, with the profile directory unchanged. **Done.**

## Evidence

Key files and snippets; versions before and after; the sign-in command. Nothing visible changed.
