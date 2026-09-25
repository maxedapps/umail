# Plan for 0002: Scoped thread reads, and an Effect- and Alchemy-native cleanup

- **Status:** Done
- **ADR:** `adrs/0002-effect-alchemy-cleanup.md`

## Goal

**Done when:**

- MCP clients limited to certain mailboxes see no content from other mailboxes in thread reads. The one exception is the opaque ids described in the ADR.
- Every simplification from the 2026-09-25 review is in.
- Dead code and needless exports are gone.
- `pnpm lint` reports 0 warnings and 0 errors, with no `overrides` block (one justified line suppression, see ADR).
- `pnpm typecheck` and the full `pnpm test` (root, worker and browser suites) pass.

**Out of scope:** the other review findings the owner chose to ignore:

- compatibility-date pinning;
- logging R2 and Cloudflare error causes;
- making `EXPECTED_TAGS` exhaustive;
- worker-test timeouts under CPU load.

Behaviour changes are limited to those the ADR lists:

- the scoped thread reads;
- the one-time rotation of the notification key;
- the CLI credential file format;
- the approval-decide checks;
- the removed `reply-plan` endpoint.

**Working rules:**

- One commit per task, credited to the owner.
- Run `pnpm fmt` only on the packages touched (it rewrites unrelated files otherwise).
- No dev server. The owner does manual QA after deploying.

## Tasks

### 1. Fix the thread scope leak

**Start in:** `apps/server/src/account/queries.ts`.

- **`selectThreadHeads`:** put the scope filter inside the `NOT EXISTS`, so a thread's head is the newest _in-scope_ live message. Replace the separate `EXISTS` clause with a plain scope filter on `m`, so cursors stay consistent.
- **`loadThreadStats`:** take the scope and filter counts and involved mailboxes by it.
- **`threadMessagesSql` / `listThreadMessageSummaries`:** add the scope filter to the message page.
- **`resolveThread`:** keep it as is. It already requires an in-scope live message, and with the page scoped, an out-of-scope handle only reveals that the thread exists.

**Verify:**

- **Store tests (`queries.worker.spec.ts`)**, with a thread spanning mailboxes A and B and a reader scoped to A:
  - The list shows A's newest message as the head.
  - Counts and identities cover A only.
  - The thread page holds A's messages only.
  - A handle pointing at B's message returns only A's messages.
  - A reader with scope `"all"` is unchanged.
- **API test (`mcp.test.ts`):** `umail_list_threads`, `umail_get_thread` and `umail_set_thread_read_state` for a scoped client never return B's subject, participants or id.

**Done:** yes. `authorization.worker.spec.ts` previously asserted the leaky cross-mailbox summaries on purpose; it now asserts the scoped ones, and a new `mcp.test.ts` case covers the three MCP tools. Both fail against the old queries.

### 2. Crypto and time on Effect services

**Start in:** a new `apps/server/src/crypto.ts`.

- **WebCrypto layer:** `WebCrypto` is a `Layer` for `effect/Crypto`'s `Crypto`, built with `Crypto.make`, `crypto.getRandomValues` and `crypto.subtle.digest`. It works in workerd and Node 22, so the App, the Durable Object, the deploy Action and tests all use the same layer.
- **Store IDs come from the caller:**
  - `submitOutbound` takes `messageId`, `jobId` and `notificationJobId` in its input.
  - `createAddress` takes `id`.
  - `claimJob` takes `attemptId`.
  - The callers (`operations.ts`, `dispatch.ts`, the preview seeding) draw them from `Crypto.randomUUIDv4`.
  - This removes `crypto.randomUUID` from `jobs.ts` and `administration.ts`.
- **Digests and HMAC become Effects:**
  - `sha256Hex` (`mail/policy.ts`) and `inboundMessageId` (`mail/archive.ts`) use `Crypto.digest`.
  - `hashApprovalToken` (`packages/api-contract/src/approval-domain.ts`) uses `Crypto.digest`.
  - `deriveApprovalToken` and `newApprovalCapability` (`mail/notifications.ts`) become Effects, using `Effect.tryPromise` over `crypto.subtle` for HMAC, since `Crypto` has none.
- **Replace the approval clock:**
  - Delete `InstantClock`, `approvalClock` and `MemoryApprovalClock`.
  - `currentIso` and the approval pages read `DateTime.now`.
  - The test world gets a `TestClock` passed through its per-request context, and tests move time with `TestClock.setTime`.

**Verify:**

- `approval-flow.test.ts` (expiry and decisions under TestClock), `submissions.worker.spec.ts`, `jobs.worker.spec.ts`, `notifications.test.ts`, `prepare-inbound.test.ts` and `receipts.worker.spec.ts` pass.
- Approval tokens derived before and after the change are equal for the same key and id, checked with a fixed-vector test in `notifications.test.ts`.

**Done:** yes. Deviation: the store's RPC layer (`makeAccountStoreRpc`, which receives the `Crypto` service at Durable Object construction) draws the address and submission ids, and `dispatchJob` draws the attempt id, so the RPC surface did not change for its callers. The outbound HTML sanitizer's message id is a fixed placeholder, since outbound mail has no attachments to resolve. The test Durable Object host supplies counter ids. The test world's `TestClock` is passed in each request's context, and `world.run` runs operations directly with that clock and `WebCrypto`.

### 3. D1 through Alchemy's `QueryDatabase` client

**Start in:** `apps/server/src/auth/access.ts` and `auth/provisioning.ts`.

- **`makeAccess`** takes the `QueryDatabaseClient` and uses `prepare/bind/first/all/run/batch`.
  - Delete `AccessDatabase`.
  - `setPolicy` becomes a named `Effect.fn`.
  - Decode rows with `Schema.decodeUnknownEffect` / typed decoders.
- **`provisionAuth`** becomes an `Effect.fn` over the same client.
  - Delete `AuthD1Database` and every `async` helper.
  - Better Auth's `getMigrations` still receives `yield* db.raw`, wrapped in `Effect.tryPromise`.
  - `new Date()` becomes `DateTime.now`, and IDs come from `Crypto`.
- **The `AuthProvision` Action** passes its existing `db` client straight through, instead of `.raw` plus a cast.
- **Tests:** add a small `memoryQueryDatabase(memoryD1)` adapter in `test/api/` (built from Alchemy's exported `PreparedStatement`). `world.ts` and `provisioning.test.ts` use it.

**Verify:**

- `provisioning.test.ts`, `provisioned-auth.test.ts`, `static-client.test.ts`, `oauth.test.ts` and `auth-boundaries.test.ts` pass.
- `tests/stack.test.ts` still shows the Action input without the password.

**Done:** yes. Access and provisioning run on Alchemy's `QueryDatabaseClient`, whose calls need `RuntimeContext`. Tests provide Alchemy's own `RuntimeContext.phantom` (plus `WebCrypto`) through `WorkerServices`/`runInWorker` in `test/api/world.ts`; the workerd test host imports it from `alchemy/RuntimeContext`, because the package root does not load in workerd. The OAuth management bridge now runs its effects with the request's context (`Effect.runPromiseWith`) until task 4 removes it. `provisioning.test.ts` moved to `@effect/vitest`, and its self-referential test (a task 6 item) is gone.

### 4. Auth through Alchemy's effectified Better Auth

**Start in:** `apps/server/src/auth/oauth-resource.ts`, then `verify.ts`, `api/mcp/route.ts`, `auth/oauth-routes.ts` and `api/app.ts`.

- **`deps.auth`** becomes Alchemy's surface:
  - `api.*` returns Effects with a typed `BetterAuthApiError`.
  - `auth` is used for `handler`.
  - Delete the `asUmailBetterAuth` cast and the `UmailBetterAuth` / `RequiredUmailAuthApi` types where the effectified API covers them.
  - Tests build the same surface over their in-memory instance with `makeApiProxy`.
- **Token checks:** `verifyOAuthBearerToken` / `verifyOAuthResourceRequest` become `Effect.fn`s with typed failures.
  - `verify.ts` and the MCP route stop wrapping them in `Effect.promise` with try/catch.
- **OAuth management pages:** `oauth-routes.ts` becomes Effect handlers over `HttpServerRequest` / `HttpServerResponse`.
  - The session comes from `api.getSession`, the device calls from `api.deviceVerify/Approve/Deny`, and forms are read through `HttpServerRequest` body helpers.
  - The injected `run` / `Effect.runPromise` goes away.
- **Better Auth hooks** in `options.ts` (`createAuthMiddleware`) run an Effect with `Effect.runPromise` at the library boundary, instead of `async` bodies.
  - Read `getOAuthProviderState()` and `ctx.body` synchronously at the hook boundary, before `runPromise`, and pass them into the Effect.
  - The provider state lives in async-local storage. A fiber that resumes on another scheduler turn could lose it. The consent hook would then write no policy and quietly leave every new MCP client with no access.

**Verify:**

- `oauth.test.ts`, `auth-boundaries.test.ts`, `mcp.test.ts`, `static-client.test.ts`, `human-pages.test.ts` and the browser suite (login, consent, device and clients flows) pass.
- After an accepted consent, a `mcpPolicy` row exists. Check this through `listMcpPolicyRows` in the Node suite.
- `tests/runtime-startup.worker.spec.ts` runs one accepted consent against the real workerd bundle, where async-context behaviour matches prod.

**Done:** yes, with deviations:

- **Typed instance, not Alchemy's effectified `api`.** In beta.77, `authInstance.api` types every method as an optional `(any) => Effect<any>` for this plugin set, which would throw away type safety. So `deps.auth` is `{ auth }`, the per-request Better Auth instance, and the few calls are wrapped as Effects where they are used.
- **The `asUmailBetterAuth` cast stays.** Better Auth types plugin endpoints as optional. The cast is now applied once, where the instance enters the app.
- **The REST auth middleware erases `RuntimeContext` with `RuntimeContext.phantom`.** The shared contract declares it with no requirements, and it always runs inside a request that carries the real context.
- **No separate workerd consent run.** `getOAuthProviderState()` is still called synchronously at the start of the hook, as before, so async-context behaviour is unchanged. The Node suite (`mcp.test.ts`) asserts the policy row after consent, and the browser suite drives the consent screen.

### 5. Worker wiring, Alchemy features and config

**Start in:** `apps/server/src/app.ts`, `account/worker.ts`, `resources.ts`, `site.ts` and `alchemy.run.ts`.

- **Shared runtime config:** one Effect (in `site.ts` or a new `runtime-config.ts`) yields what both the App and the Durable Object need:
  - the HTML policy;
  - the notification key;
  - the application URL;
  - the operator id;
  - `makeAccess(authDb, …)`.

  This removes the duplicated wiring.

- **Notification key:**
  - Declare `NotificationKey = Alchemy.Random("NotificationKey")` in `resources.ts` and decode its 64 hex characters into the 32-byte key.
  - Delete `UMAIL_NOTIFICATION_KEY` from `.env.example`, `README.md`, `docs/operations.md` and the test fixtures.
- **Router built once:**
  - Build the HTTP router once in the Worker constructor, under a scope created there (the constructor has no ambient scope, per Alchemy's Worker docs).
  - `fetch` becomes the built handler.
  - Alchemy provides the `RuntimeContext` per request for the auth and D1 calls.
- **Archive reader:** `MailArchiveReader` carries its real requirement, removing the `as Effect.Effect<…>` cast in `app.ts`.
- **Config:**
  - `rootDomain` and `operatorEmail` use `Config.schema`, with the contract's `MailDomain` / `ExternalMailAddress` schemas and the same normalisation the parse functions do today. Bad values then surface as `ConfigError`.
  - `AUTH_OPERATOR_ID` stays `Config.string`.
- **`alchemy.run.ts`:**
  - Merge the two `Effect.provide` calls into one.
  - Draw `runNonce` from `Crypto`.
- **Durable Object:** keep Alchemy's documented shape and add one line suppression of `return-effect-in-gen`, with the reason.

**Verify:**

- `tests/runtime-startup.worker.spec.ts` boots the real bundle: Durable Object schema, seeding, alarm, and a request through the prebuilt router.
- `tests/stack.test.ts` shows the new `NotificationKey` resource and no `UMAIL_NOTIFICATION_KEY` binding.
- `vitest.worker.config.ts` and the stack fixture resolve the new output into a binding.
- **Approval-link round trip, in the real bundle:** a submit that needs approval produces a notification from the Durable Object. The link token in that notification must then look up the same approval through the API. The API hashes the token and the Durable Object derives the link, both from this key, so a mismatch would break every link without throwing.
- `site.test.ts` covers the config errors.
- `queue-handler.worker.spec.ts` passes.
- **Manual, by the owner after deploy:** an approval-required send produces a notification whose link opens and decides.

**Done:** yes, with deviations:

- **Router: reverted to per-request build (see ADR decision 3).** Building it in the constructor failed at plan time, where `yield* AccountStore` is undefined. Building it once on the first request (`Effect.cached`) shipped in the task 5 commit, but the final review found two faults:
  - The cached router kept the first request's services, including its `HttpServerRequest`, so later REST calls authenticated with the first request's bearer token. A throwaway test reproduced it: an unauthorized request returned 200.
  - workerd rejects a Durable Object stub reused from another request.

  The fix restores per-request building, with the other deps built once. The workerd test pool cannot call store RPC methods, so no runtime spec covers this.

- **The notification key is read lazily.** `appRuntime.notificationKey` is an `Effect` over the `Random` accessor, because the binding exists only at runtime.
- **Only the store's side of the round trip runs in workerd.** `tests/runtime-startup.worker.spec.ts` sends a queued approval notification through the real bundle's alarm with the bound `NotificationKey`, and it fails when the key is malformed. The API side cannot run there, because that bundle has no provisioned auth. It is covered by the Node round trip in `approval-flow.test.ts`, and both sides read the key from the one `appRuntime`.
- **Email validation error.** An invalid `UMAIL_OPERATOR_EMAIL` now fails with the schema's `ConfigError` rather than the old "not a valid email address" text.

### 6. Server simplifications

**Start in:** `api/approval-http.ts`.

- **Approval decision:** decode the token, hash it, make one `decideApproval` store call, and map the result.
  - The store's `resolved` result carries `expiresAt`, so the page can still say "gone" for an approval that expired.
  - Delete the extra lookups and `messageMatchesApproval` from the decide path. The review page keeps loading the message.
- **Delete the `reply-plan` endpoint:**
  - `getReplyPlan` in `api-spec.ts`, `ReplyPlan` / `ReplyPlanQuery`, the handler, the operation, and its three uses in `api.test.ts`.
  - Keep reply-all derivation covered through the reply submission tests and `reply-plan.test.ts`, which tests `deriveReplyRecipients` and stays.
- **Delete the return-path twin:**
  - Delete `sameOriginReturnPath` and `configuredOriginAllowed` from `runtime-surface.ts`, and inline the origin check into `cookieMutationAllowed`.
  - Drop the script-source substring assertions in `auth-pages.test.ts`. The browser spec already covers `next=` handling.
  - Change `auth-boundaries.test.ts:174` to assert the `Location` header.
- **Routing provider (`mail/routing.ts`):**
  - `read` returns plain attrs.
  - Remove `adopt()` / `retain()` from `MailRoutingDomain` and the `Unowned` import. `retain()` on `MailRouting` stays.
  - Remove the matching assertions in `tests/stack.test.ts` and `test/mail/routing.test.ts`.
- **Smaller deletions:**
  - `humanPageHttpApiResponse` returns the response directly, without the unused `status`.
  - Merge `recipientsAllowed` and `recipientsPreapproved` in `jobs.ts`.
  - Delete the self-referential test at `provisioning.test.ts:305-324`.

**Verify:** `approval-flow.test.ts`, `api.test.ts`, `auth-boundaries.test.ts`, `auth-pages.test.ts`, `routing.test.ts`, `stack.test.ts`, `reply-plan.test.ts` and the browser suite pass.

**Done:** yes. The provisioning test deletion happened in task 3. The hostile `next=` cases that only the TS twin covered (`//evil.example`, `/\evil.example`, `/login`) moved into the browser spec, which runs the real login script. `jobs.ts` has one `allRecipientsIn` helper.

### 7. CLI

**Start in:** `apps/cli/src/credential-store.ts`.

- **Rewrite the store on `FileSystem`:**
  - Operations: `read`, `withLock` (one `mkdir` lock with a stale timeout), `write` (temp file with mode `0600`, then `rename`) and `remove`.
  - Owner, mode and symlink checks use `stat` + `realPath`.
  - The path comes from `Config` (`XDG_STATE_HOME`, else `HOME`).
  - Delete the generation counter, the refresh lock, `version` / `kind`, `registeredCredentialState` and the `node:*` imports.
  - `login` writes a fresh file without reading the old one, so it works on an old-format file. Other commands report login required until the owner runs `umail login` once.
- **`auth.ts` holds the one lock around the right steps:**
  - refresh: read, refresh, write;
  - logout: read, revoke, remove;
  - the login commit.
- **Lazy effects:** `login`, `accessToken` and `logout` become Effect values, not zero-argument functions.
- **Shared constants:** move `UMAIL_CLI_CLIENT_ID` and the two scopes into `@umail/api-contract`, used by both the server and the CLI.
- **`--since-hours`:** `instantFromHours` uses `DateTime.now`.

**Verify:**

- `auth.test.ts`, `cli.test.ts` and `tests/credential-processes.test.ts` pass, adjusted for:
  - no generation;
  - one lock;
  - logout deleting the file;
  - a symlinked or world-readable file or directory still being rejected.
- `tests/client-artifacts.test.ts` still builds a working bundle.

**Done:** yes. A signed-in credential file from an older version still decodes (extra fields are ignored), so no re-login is needed. `auth.test.ts` moved to `@effect/vitest`; its generation cases gave way to one that checks every write and removal happens under the lock. The cross-process tests (delayed refresh versus logout, overlapping refreshes, SIGINT, stalled revocation, a live lock, and corrupt, world-writable or symlinked files) pass unchanged in intent. The file sync and directory sync after the atomic rename were dropped: losing the file on power loss only means logging in again.

### 8. Effect idioms across the source

**Start in:** `apps/server/src/api/operations.ts`.

- **Named `Effect.fn`:** convert every `function f(…) { return Effect.gen(…) }` in `apps/*/src` and `packages/*/src` (about 47 sites) to `Effect.fn("f")`, and name the unnamed `Effect.fn`s in `routing.ts` and `provisioning.ts`.
- **Remaining source lint:**
  - `projection.ts`: build the objects without spreading class instances.
  - `api-spec.ts:41`: `Schema.Number` becomes `Schema.Finite`.
  - `operations.ts`: `Effect.succeed(undefined)` becomes `Effect.void`.
  - Remove the unused imports.

**Verify:** `pnpm typecheck`, and `pnpm lint` reports nothing in `apps/*/src`, `packages/*/src` or `alchemy.run.ts`.

**Done:** yes. Named functions that wrapped `Effect.gen` are now `Effect.fn`, as are the store's `submitOutbound`, the destinations client's `ensure` and the credential store's `write`. HttpApi handler callbacks and the Worker's event callbacks stay inline, where the library names the span. The conversion surfaced new warnings, all fixed: synchronous Schema calls inside generators became their Effect forms, `Effect.try`'s `unknown` error became an `APIError`, and a redundant `orDie` was hoisted. The receipt-id JSON is encoded through Schema, byte-identical to `JSON.stringify`.

### 9. Tests on `@effect/vitest`, and no lint overrides

**Start in:** a spike.

- **Spike first:** convert one worker spec and one browser spec to `it.effect`, and run them in their real pools (workerd, Playwright).
- **Then find the real work:** delete the whole `overrides` block in `oxlint.config.ts`, run `pnpm lint`, and work from the actual warning list.
- **Which files convert:** only files that run Effects or produce warnings. Pure synchronous tests (e.g. `mailbox-address`, `message-threading`) stay on plain `it`.
- **How converted files change** (with `it.layer` where a shared layer helps):
  - Effect code runs with `yield*`, and time uses `TestClock`.
  - Promise-only harnesses are wrapped with `Effect.promise` / `Effect.tryPromise`: Durable Object stubs in worker specs, Playwright in browser specs, and spawned processes and HTTP servers in `tests/*`.
  - `new Promise` / timers become `Effect.async` / `Effect.sleep`.
  - `JSON.parse` becomes `Schema.fromJsonString`.
  - `node:*` file access in tests becomes `FileSystem` / `Path`.
- **Config file:** `vitest.worker.config.ts` builds its config with one `Effect.runPromise` of an Effect program, using `Path` instead of `node:path`.
- **Unused variables:** remove the ones in `approval-flow.test.ts` and `oauth.test.ts`.

**Verify:** all four suites pass (`vitest run`, `pnpm test:worker`, the server `test:worker` and `test:browser`), and `pnpm lint` reports 0.

**Done:** yes. The spike (a worker spec on `it.effect` in workerd) passed. The overrides block is gone, and `pnpm lint` reports 0 warnings and 0 errors. The shared test helpers (`world.ts`, `oauth-flow.ts`, `mcp-drivers.ts`, the account harness) have Effect APIs. `world.ts` builds its router on the world's `TestClock`, because the router keeps the services it was built with. Six parallel conversions followed, one per test group, each keeping every assertion. Details:

- Process tests spawn the CLI with `ChildProcess` and serve the fake OAuth endpoints with `NodeHttpServer.layerTest`.
- Real-time suites run with `excludeTestServices`.
- The browser config pre-bundles `@effect/vitest`, which a cold Vite cache otherwise reloads mid-run.
- `Schema.UnknownFromJsonString`, which the lint messages suggest, does not exist in rc.112, so tests use `Schema.fromJsonString(Schema.Unknown)`.
- The thread-paging spec still times out when all 15 server worker files run in parallel (it takes 231 ms alone). That is the load-sensitive flake the owner kept out of scope, and it passes on rerun.

### 10. Dead code and exports sweep, final check

**Start in:** the export inventory from the review.

- **Un-export** symbols used only inside their own module. Examples:
  - brand constants in `identity.ts`;
  - page view types in `human-pages/*`;
  - the result types in `mailbox-address.ts` and `principal-authorization.ts`;
  - `apiLayers`, `EXPECTED_TAGS`, `accountMigration0010Sql` and `threadMessagesSql`.
- **Delete** anything left with no use after tasks 1–9.
- **Keep** exports that tests use to test a module's behaviour.

**Verify:** `pnpm typecheck`, `pnpm lint` (0 warnings), the full `pnpm test`, `pnpm build:clients`, `pnpm fmt` on the touched packages only, and `git status` showing no stray files.

**Done:** yes. 103 exports that only their own module used lost `export`. No symbol, source file or dependency was left without a use (`bin.ts` is the CLI entry and `css-tree-subpaths.d.ts` holds ambient types). Results: `pnpm typecheck` passes, `pnpm lint` reports 0 warnings and 0 errors, and `pnpm build:clients` builds. All suites pass except the load-sensitive thread-paging spec, which times out in the full parallel server-worker run and passes alone (out of scope, see Goal).

## Open questions

None. The owner decided tests, API deps, the notification key and the credential store on 2026-09-25.
