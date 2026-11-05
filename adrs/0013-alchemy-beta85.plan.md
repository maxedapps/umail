# Alchemy beta.85 and Effect 4.1 plan

## Goal

Move umail to Alchemy 2.0.0-beta.85 and Effect 4.1.2 with the tooling infinite's task 2311 settled on (tsgo 0.67.1, oxlint 1.91, tsgolint 7.0.2005, Vitest 5.1.0), so it can open the v8 state store and deploy again, and delete what the upgrade makes obsolete.

## Non-goals

- Deploying `prod` or Academind: both need Max's go. Prod is dry-run only.
- Other feature work. Alchemy #2843 (uninterruptible refresh) is still open; umail never carried a patch for it and takes none here.

## Tasks

1. **Versions.** Bump every manifest, add `@alchemy.run/cloudflare` and `@alchemy.run/domain`, bump the `@cloudflare/workers-types` override to the peer beta.85 needs. Verified by a clean frozen install.
2. **Imports.** `alchemy/Cloudflare` moves to `@alchemy.run/cloudflare`. Verified by types and by evaluating `alchemy.run.ts` in Node.
3. **Crypto.** `effect/Crypto` split into `effect/crypto/SecureRandom` and `effect/crypto/Digest`; `apps/server/src/crypto.ts` provides both over WebCrypto, the CLI gets `NodeCrypto.layerSecureRandom` through `apps/cli/src/platform.ts`. Verified by the Node, worker and credential process tests.
4. **Lint.** Fix the new findings: construct Schema classes where a class is the declared type, rename the `name` fields that shadow an error's own name, drop unused imports. `schema-class-missing-brand` stays on: every Schema class and error takes the nominal brand it asks for. `patchAddress` takes the store's plain `PatchAddressInput`, which is what crosses the Durable Object boundary.
5. **Obsolete code.** Delete `patches/alchemy@2.0.0-beta.81.patch` and `tests/alchemy-refresh-lock.test.ts`: #1923 ships in beta.85, shown by that test passing unpatched before its deletion. Update `docs/operations.md`.
6. **Live check.** Own test stage: deploys and starts, login works, inbound mail routes. Retire its mailboxes, verify owned rules are gone, destroy, report leftovers.
7. **Prod dry-run.** `--dry-run --no-input`, without `--yes`, so an outdated store stops instead of upgrading. Record the plan and the store's version. Max's account store was v7: tasks 6 and 7 needed its one-way move to v8, which Max approved and the stage's `--dry-run --yes` carried out.

8. **Test runners.** Vitest 5.1 caches modules on disk and hands fresh workers a snapshot of them. `@cloudflare/vitest-plugin` 1.5.1 reads those paths in workerd, and the server worker suite turns `fsModuleCache` off, because a later worker's whole graph in one WebSocket message exceeds workerd's limit (1009). `pnpm dedupe` keeps one `zod` and one `better-call` after the plugin's exact `zod` pin, since a second `better-call` breaks better-auth's `instanceof APIError` (the authorize endpoint then answers 400 instead of redirecting with `invalid_target`). A Worker's `main` is a cwd-relative path now, so the root worker config passes it straight to the bundler. Verified by every suite in `pnpm test`.

9. **Patch over RPC.** The stage showed `PATCH /addresses/:id` answering 500: the route passes its decoded `PatchAddressPayload` to the Durable Object, and Workers RPC refuses a class instance. `operations.patchAddress` passes a plain copy, and the memory store's `patchAddress` refuses class instances as RPC does, so the API tests cover it. Verified red without the fix in the Node tests and in real workerd RPC.

## Evidence

No UI changes. The report carries the stage's check results, the prod plan, the store's version and any one-way step, plus key files and excerpts from the landed commit.

## Open questions

None.

## Settled findings

- medium bug: `Effect.context<Crypto>()` in the Durable Object captures the whole init context, and providing it around every alarm restored the init logger over the event's structured logs — fixed: `Context.pick` keeps only `SecureRandom` and `Digest`.
- medium nit: turning `schema-class-missing-brand` off breaks the brief's "fix, don't suppress", and `schema-class-object-literal` does not catch a structural variable — fixed: rule on, 42 classes branded; the brands exposed one structural `MailContact` and two query values, now constructed.
- medium bug: `withRpcBoundary` in the memory store failed lint on `Reflect.get` and `Reflect.apply` — fixed: replaced by a typed wrapper around `patchAddress`, the method the stage saw fail.
- niche nit: the AGENTS.md note overstated which commands upgrade the store on their own — fixed: names `alchemy dev` and `alchemy state bootstrap`; `alchemy state` inspection prompts or refuses, and `exec` is not a public command.
