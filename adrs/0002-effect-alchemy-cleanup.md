# 0002: Scoped thread reads, and an Effect- and Alchemy-native cleanup

- **Status:** Accepted (2026-09-25)
- **Date:** 2026-09-25

## Context

The 2026-09-25 full-codebase review found one real defect and a list of simplifications.

**The defect.** Thread reads ignore a client's mailbox scope. An MCP client scoped to one mailbox sees other mailboxes' messages in any thread that spans mailboxes:

- `umail_list_threads`, `umail_get_thread` and `umail_set_thread_read_state` return the other messages' subjects, participants, envelopes and attachment names.
- `umail_list_threads` also returns counts and mailbox identities across all mailboxes.
- Bodies stay protected.

**The rest** is complexity and inconsistency:

- Lint reports about 170 warnings, and a lint override hides the same rules in some source and test folders.
- Promise islands are bridged with `Effect.runPromise` in the middle of requests.
- Hand-typed D1 interfaces sit on top of `.raw` bindings, although Alchemy ships an Effect-native D1 client.
- A hand-rolled clock duplicates `Clock`.
- The HTTP router is rebuilt on every request.
- A manually generated notification secret needs a "keep it stable" operating rule.
- The approval decision takes five store calls.
- One endpoint and one helper exist only for tests.
- The CLI's credential store carries two locks, a generation counter and a leftover "registered" state from dynamic client registration.

The owner wants the defect fixed, every simplification done, zero lint warnings without overrides, and Effect and Alchemy used the way their docs intend.

## Decision

1. **Scope every thread read.**
   - A thread is visible when it has a live message in scope. The listing shows the newest in-scope message.
   - Counts, identities and thread pages include only in-scope messages.
   - Opaque ids are the one exception. A thread id is the id of its founding message, and `parentMessageId` may point at a message outside the scope. No content is attached to those ids, and bodies stay gated per message.
2. **Use the platform's Effect-native surfaces instead of hand-rolled ones:**
   - D1 goes through Alchemy's `QueryDatabase` client.
   - Better Auth goes through Alchemy's effectified `api`.
   - Randomness and digests go through Effect's `Crypto` service, backed by WebCrypto.
   - Time goes through `Clock`/`DateTime`, tested with `TestClock`.
   - Configuration goes through `Config.schema`, so errors surface as `ConfigError`.
   - The CLI's files go through `FileSystem`.
   - Functions that return Effects use named `Effect.fn`.
3. **Keep API dependencies as one explicit `deps` object.** Per-request values (the auth instance, D1) are Alchemy clients whose calls run in the request's `RuntimeContext`. The router is still built per request.
   - _Amended during implementation:_ the plan built it once per isolate. Review showed that a router built inside a request keeps that request's services, including the request itself. Later requests then ran with the first request's credentials, and workerd refuses Durable Object stubs from another request.
4. **Replace `UMAIL_NOTIFICATION_KEY` with an `Alchemy.Random` resource.** It is minted once and kept in encrypted state.
5. **The account store stays synchronous and transactional.**
   - IDs come from `Crypto` in the Effect caller and are passed in.
   - Store functions no longer generate randomness.
6. **Simplify the CLI credential store.**
   - One lock serialises refresh, login commit and logout.
   - Logout deletes the file.
   - The generation counter, the second lock and the "registered" state go.
   - Owner, mode and symlink checks stay, via `stat` and `realPath`.
7. **Tests use `@effect/vitest`**, with every lint override removed. Promise-only harnesses (Durable Object stubs, Playwright, child processes) are wrapped with `Effect.promise`/`Effect.tryPromise`.
8. **Delete what nothing needs:**
   - the `reply-plan` endpoint;
   - the TS twin of the login page's return-path check;
   - the no-op adopt/retain/`Unowned` settings on `MailRoutingDomain`;
   - duplicate store checks in the approval decision;
   - the unused `status` field in the page-response helper, and the test that proves nothing;
   - exports used only inside their own module.

## Alternatives

| Option                                                                 | Why not                                                                                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Simplest:** fix the leak only, and set noisy lint rules to "off"     | It reaches zero warnings by hiding them and keeps every hand-rolled piece. The owner asked for the opposite.                            |
| Move API deps to Context services and layers                           | About seven new service definitions, plus rewrites of `operations.ts` and the test world, for no behaviour gain. Rejected by the owner. |
| Keep node:fs for the credential store's `lstat`/`O_NOFOLLOW` hardening | Needs a lint override. The race it guards needs an attacker running as the same user.                                                   |
| Convert the account store to `@effect/sql-sqlite-do`                   | Loses `transactionSync` atomicity, which at-most-once sending relies on.                                                                |
| Keep tests on plain vitest behind the existing override                | Rejected: the owner wants no overrides.                                                                                                 |

## Consequences

- **The notification key rotates once**, on the first deploy. Approval links that are still pending at that moment stop working.
- **The CLI's credential file format changes.** A signed-in `oauth.json` from an older version still decodes, because decoding ignores the extra fields. A logged-out leftover file, which holds no tokens, reports "missing or insecure" until the next `umail login` replaces it.
- **An approval decision no longer re-checks the message's shape.** It used to require exactly one sender and at least one recipient. The store's state checks decide instead, and the review page still loads the message.
- **The API contract drops `GET /messages/:id/reply-plan`.** It had no caller.
- **About 60 test files change mechanically.** Browser and Durable Object specs get noisier, because each Promise step is wrapped in an Effect.
- **Tests rely on one internal Alchemy helper.** They build Alchemy's effectified Better Auth surface with `makeApiProxy` (`@alchemy.run/better-auth/ApiProxy`, marked internal). An Alchemy upgrade may need a test-side adjustment.
- **The credential store drops `O_NOFOLLOW`.** It relies on its private `0700` directory, plus owner, mode and `realPath` checks.
- **The Alchemy DO pattern needs one lint suppression.** Alchemy's documented Durable Object shape returns the per-instance initializer from the outer effect. That trips `return-effect-in-gen`, so it keeps a single justified line-level suppression. That line is the only exception to "zero warnings, no overrides".
