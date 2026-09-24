# Plan: consistent mail and access flows (ADR 0001)

- **Status:** In progress
- **Review:** an independent adversarial review found 4 material and 8 minor findings, none blocking. All were applied except: the icon cleanup stays in (the owner asked for dead files to go), and the `SendClient` switch was dropped rather than patched.
- **Goal:** implement ADR 0001.
  - One Worker, whose mail store drives its own due work through its Durable Object (DO) alarm.
  - Access policies live in D1, with the scope chosen on the consent screen.
  - Forwarding treats Cloudflare as the only source of truth.
  - The Alchemy and Effect idiom cleanups.
  - Every file and concept the design no longer needs is deleted.
  - Prod is torn down and redeployed.
- **Out of scope:** Cursor support (the patch and the static client both stay), the vendored anti-slop lint rules, tsdown CLI bundling, and new features.
- **Evidence:**
  - Research lanes, 2026-09-24. Alchemy DO `alarm` shape: `DurableObject.ts:104-107`. Single Worker with several event sources: `WorkerRuntimeContext.ts:95-130`.
  - `runDurableObjectAlarm` is exported by `@cloudflare/vitest-plugin` 1.1.7.
  - The routing SDK calls hit the same `/email/routing/dns` endpoints as today.
  - The OAuth deploy profile has no API-token-write scope, so `CF_EMAIL_ROUTING_TOKEN` stays a manual secret.
  - D1 enforces foreign keys by default.

**Every task's checks:** `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test` (node, worker and browser suites), and scoped `pnpm exec oxfmt <paths>`. No dev server. The owner does the manual browser checks.

## Tasks

### 1. One Worker, and the store drives its own work

**Change:**
- **Worker.** Collapse the five Workers into one `App` Worker class in `apps/server/src/app.ts`, wired from `alchemy.run.ts`:
  - `fetch` (the HttpApi app), plus `Cloudflare.email().subscribe` (from `mail/inbound.ts`);
  - `consumeQueueMessages(MailIndex, {batchSize: 1, maxConcurrency: 1})` (from `mail/indexing.ts`);
  - a locally hosted `AccountStore`.

  Delete the Worker classes and `make` blocks from `api/worker.ts`, `inbound.ts`, `indexing.ts`, `send.ts` and `recovery.ts`, along with every `AccountStore.from(Api)`. Mail modules become plain Effect functions with no `Api` import.
- **Store alarm.** Add `alarm` to the AccountStore shape. `runDueWork` runs four independent steps, each capturing its own `Exit`:
  1. Expire approvals that are due. This is the only expiry writer; it rejects both unsent jobs via `rejectUndispatched`.
  2. Send ready jobs, at most 10 per pass: prepare, claim, send, complete.
  3. Settle expired `in_flight` claims to `unknown`.
  4. Redrive due receipts to MailIndex.

  After the steps, set the alarm to the earliest step due time. A failed step's own due time is floored at `now + 60 s`, and any other step with work left gets `now`. A job that fails counts as its step failing, so a stuck `ready` job cannot cause a tight alarm loop.

  Arm the alarm on submit, approve, receipt registration and DO start. Remove every expiry write outside the alarm: a POST past `expires_at` returns "gone" and writes nothing.
- **Policy as an argument.** `submitOutbound` and the claim take the requester policy as an argument. The pass gets it from `policyFor(requester)`, which task 1 backs with the existing store table; task 2 only repoints it at D1.
- **Deletions.**
  - Infrastructure: `mail/recovery.ts`, SendConsumer, the `MailSend` queue, the cron.
  - `send.ts`: the queue plumbing (`SendJobWork`, `settleSendMessage`, `handleSendMessages`). What remains is `mail/dispatch.ts`, which holds prepare, notification mail and `dispatchJob`.
  - Store RPCs: the dispatch RPCs (`claimDispatch`, `completeAttempt`, `rejectReadyDispatch`, `getOutboundDispatch`, `recoverOutbound`, `redriveDueInboundReceipts`) become internal to the pass.
  - `SEND_CONSUMER_CONCURRENCY`.
- **Failure classes.** Rejections before the send get `policy` plus a detail, never `provider`. One `rejectUndispatched(messageId, class, detail)` replaces `rejectJob`, `cancelApprovalOfFailedNotification` and `cancelUndispatchedJobsForMessages`. A notification rejected by a policy re-check rejects both jobs as `policy`.
- **Approval page** (`human-pages/approvals.ts`):

  | Job state | Page says |
  |---|---|
  | `ready` / `in_flight` | "sending" |
  | `rejected` + provider | "Cloudflare rejected (code)" |
  | `rejected` + any class except provider | "not sent (class: detail)" |
  | `unknown` | "unconfirmed" |

- **Missing outbound record.** It throws like inbound: `MessageIntegrityError` with `job_missing`. Delete `UNKNOWN_OUTBOUND_JOB`, and move the test-only `acceptOutbound` into the test host.
- **Idioms.** The store reads the site through `currentSite` in its outer init; drop the `UMAIL_MAIL_DOMAIN` and `UMAIL_PREVIEW_MAILBOXES` env copies. Keep the raw send binding, because `SendClient` wraps provider codes and would change classification.

**Starts at:** `apps/server/src/api/worker.ts`, `account/worker.ts`, `account/jobs.ts`, `mail/send.ts`, `mail/recovery.ts`, `alchemy.run.ts`, `tests/stack.test.ts`.

**Verify:**
- **Stack wiring, first.** TypeScript can't catch DO layer miswiring. `tests/stack.test.ts` must assert:
  - the one Worker has `send_email`, the MailIndex producer and consumer, D1, R2, the DO and the domain;
  - there is no MailSend queue, no cron, and no other Worker.

  `pnpm test:worker` builds the single entrypoint, and `runtime-startup.worker.spec.ts` boots it, including the email, queue and alarm registration. Add the MailIndex producer and consumer bindings and `send_email` to the miniflare configs.
- **New account alarm spec**, using a fake sender and a fake index:
  - submit arms the alarm, and one pass sends once while a second pass is a no-op;
  - notify → approve → message;
  - expiry rejects both unsent jobs;
  - an abandoned claim becomes `unknown`;
  - a failing redrive doesn't block sends and re-arms at +60 s;
  - more than 10 ready jobs re-arm at `now`;
  - an HTML failure is recorded as `policy`, with no provider call;
  - a policy-denied notification gives `policy` on both jobs;
  - `nextDueAt` covers all four sources;
  - one real `runDurableObjectAlarm` round trip.
- **Approval page copy tests** for each state.
- **Queries test:** an outbound message whose job is missing throws.
- **Deleted tests:** `recovery.worker.spec.ts` and `send-consumer.worker.spec.ts`. Their surviving cases move to the alarm spec.

**Done:** yes (2026-09-24).
- One `App` Worker in `apps/server/src/app.ts`; the stateful resources live in `src/resources.ts`, so the mail and account modules import no Alchemy runtime code. The store is bound as the local `AccountStore` (`.from(App)` added a duplicate self-binding).
- The pass is `account/due-work.ts` (`runDueWork`, `armDueWork`), and sending is `mail/dispatch.ts`. Arming computes the next due time from SQL and sets or deletes the alarm in the same turn.
- The alarm cases are mostly a node test (`test/account/due-work.test.ts`, 12 cases on the real store over node:sqlite), plus one `runDurableObjectAlarm` worker spec. The runtime spec checks that the real bundle arms the alarm on start. `SELF.queue` fails with DATA_CLONE_ERR in the test pool, so queue wiring is asserted in the stack test instead.
- The two server worker configs merged into `apps/server/vitest.worker.config.ts`, and `bundleMailTestModules` is deleted (candidate items 2 and 5).
- Gates: typecheck 0, lint 0 errors (177 warnings, the new ones test-only), tests 391 node + 3 runtime + 39 + 112 worker + 7 + 12 browser.

### 2. Access in D1, scope chosen at consent

**Change:**
- **D1 table.** Provisioning creates `mcpPolicy(consentId TEXT PRIMARY KEY REFERENCES oauthConsent(id) ON DELETE CASCADE, policy TEXT NOT NULL)`.
- **`auth/access.ts`.** An Effect service over Alchemy's D1 `QueryDatabase` with `mcpAccess(clientId)`, `list()`, `setPolicy(consentId, policy)` and `revoke(clientId)`. `revoke` deletes the consent and refresh tokens in one batch, and the cascade removes the policy. Access checks fail closed: no consent, no policy, or an undecodable policy all mean no access.
- **Consent screen.**
  - The page (`human-pages/auth.ts`) adds mailbox scope and send-mode fields, pre-filled with "all mailboxes / every send needs approval". The fields go in the same POST to `/api/auth/oauth2/consent`.
  - A `hooks.after` on `/oauth2/consent`:
    - does nothing unless the request was accepted and succeeded;
    - reads `client_id` via `getOAuthProviderState` and the policy from the raw body;
    - finds the consent by (clientId, userId), then writes `mcpPolicy` through a port passed into `makeAuthOptions`. Provisioning's migration options pass a no-op port.
  - An invalid policy throws `APIError`, which replaces the response.
  - Evidence: the oauth-provider `before` hook already verifies the signed query (`authorize-BmTe2VYG.mjs:4460-4478`). The body object is not strict, and hooks see the raw body (better-call `dispatch.mjs:191-200`).
  - "Deny" is unchanged.
- **Principal.** The MCP route builds its principal from `mcpAccess` and checks `sub === operatorId`. Delete `ensureMcpOAuthPolicy`.
- **Store.** Delete the store's `mcp_oauth_policies` table, the six policy functions and their RPCs, and `loadRequesterPolicy`. `submitOutbound` and the pass's claim take the policy as an argument: the Api passes `principal.policy`, and the pass reads `Access.mcpAccess` for MCP requesters at claim time.
- **`/clients` page.** One query lists every grant: consents left-joined to `mcpPolicy`, plus clients holding refresh tokens (the CLI). A consent with no policy shows as "no access". MCP rows get the policy form, and every row gets Revoke.
- **Deletions:**
  - the REST `McpClientsGroup` and the CLI `clients` commands and policy flags;
  - `canAdmin`/`canDelete`, `requireAdmin`/`requireDelete`, and the `active`/`disabled`/`revoked` states;
  - `auth/deployment-gate.ts` and the `umailAuthControl` table and helpers. Keep the password-change deletes. Provisioning reads the operator id from the existing `user` row by email, and creates a UUID only when none exists;
  - `resources`/`resourceSeedMode` and `clientRegistrationAllowedResources` from runtime `options.ts`. Provisioning then writes the resources, and `mcp()`'s insert-only seed of its own resource is the only other writer. The static Cursor/Grok client and the Cursor patch stay.
- **CLI client.**
  - One static client, `umail-cli` (device code plus refresh, REST resource only), provisioned. The CLI drops dynamic registration.
  - Dynamic registration is limited to authorization-code clients on the MCP resource.
- **`umail logout`.** Revoke remotely first. Delete local credentials only on success; otherwise keep them and exit non-zero.

**Starts at:** `apps/server/src/auth/*`, `api/mcp/route.ts`, `api/human-pages/{auth,oauth-management}.ts`, `account/administration.ts`, `account/jobs.ts`, `packages/api-contract/src/principal-authorization.ts`, `apps/cli/src/{auth,credential-store}.ts`.

**Verify:**
- **Worker spec (D1 in miniflare, with a better-auth schema fixture):** revoking cascades and deletes the policy row. This proves the local engine; production D1 enforcing foreign keys is documented platform behaviour, and step 7 checks it live.
- **Consent tests:**
  - accepting with a chosen scope creates consent plus policy through the hook, and the client is listed immediately;
  - an invalid policy body is rejected, and no consent is left without a policy;
  - a consent without a policy gets 403;
  - revoke gives MCP 403 at once, refresh fails with `invalid_grant`, and re-authorizing shows the consent screen;
  - revoking the Cursor client keeps its registration, and it can reconnect.
- **Registration:** dynamic registration rejects device-code and REST-resource requests.
- **Pass:** a job from a revoked or narrowed client is rejected at claim.
- **CLI:** logout keeps the local file when remote revoke fails, and login makes no registration request.
- **Provisioning:** a password change deletes sessions, tokens and consents.
- **Owner's manual browser check:** the consent form and the `/clients` list.

**Done:** yes (2026-09-24).
- `mcpPolicy` is a better-auth plugin model (`auth/options.ts`, `mcpPolicyPlugin`). Better Auth's own migration creates it, and its reference to `oauthConsent` cascades by default. So provisioning needs no extra SQL and the hooks write through the adapter; no policy port.
- A `before` hook rejects an invalid policy before the consent exists. The `after` hook writes it, finding the consent by `client_id` (from `getOAuthProviderState`) and the operator id.
- `auth/access.ts` holds `mcpPolicy`, `list`, `setPolicy` and `revoke` over the raw D1 binding (the same type better-auth and the node fake use). The Durable Object reads `AUTH_OPERATOR_ID` at runtime for its `policyFor`.
- Consents are only created by `POST /oauth2/consent`. Device approval writes none, and no static client skips consent, so no grant bypasses the hook. `node:sqlite` enforces foreign keys by default, so the cascade is proven in node tests too.
- Deviation: the MCP principal label is the neutral `OAuth client <id>`. A registered client name is self-chosen, so it isn't shown as the requester on approval pages.
- The CLI `Config` work from task 5 was done here too, since both touch the same `env` threading.

### 3. Forwarding: Cloudflare is the only source of truth

**Change:**
- **Schema.** `addresses.forward_to TEXT NULL`. Delete the `forwarding_destinations` table and the destination functions and RPCs.
- **`api/destinations.ts`.** Rewrite it on `@distilled.cloud/cloudflare/email-routing`, pinned exactly as a direct dependency. `ensureDestination(email)` exhausts `listAddresses.pages`, matches case-insensitively, creates one only if missing, and returns `{email, verified}`.
- **Routes.** `PUT /addresses/:id/forwarding {email}`:
  - a missing address returns 404 with no Cloudflare call;
  - otherwise it ensures the destination, stores the email, and returns `{address, verified}`;
  - Cloudflare failures return `ApiProblem` with Cloudflare's message.

  `DELETE /addresses/:id/forwarding` nulls the column and never touches Cloudflare. Delete the four `/forwarding-destinations` routes.
- **Inbound.** Forward whenever `forward_to` is set, record the outcome, and drop the verified gate.
- **CLI.** `forwarding set --address-id --email` and `forwarding remove`. Delete the `destinations` commands.
- **Kept:** the manual `CF_EMAIL_ROUTING_TOKEN`.

**Starts at:** `apps/server/src/api/destinations.ts`, `api/app.ts`, `account/administration.ts`, `mail/inbound.ts`, `packages/api-contract/src/api-spec.ts`, `apps/cli/src/commands/index.ts`.

**Verify:**
- **Client tests:**
  - an address listed with a different case is adopted with no create call;
  - a missing address is created;
  - a Cloudflare error message surfaces.
- **API tests:**
  - PUT stores the email and returns live `verified`;
  - an unknown address makes no Cloudflare call;
  - DELETE makes no Cloudflare call.
- **Receipts spec:** an unverified forward records `failure` and still accepts the mail.

**Done:** yes (2026-09-24).
- `api/destinations.ts` uses the SDK's `listAddresses.items` (every page, stopping at the first match) and `createAddress`, with the SDK's `fromApiToken` plus `FetchHttpClient`. Errors surface Cloudflare's own message.
- Tests pass a fake `Fetch` per call, because the default fetch reference is captured once.
- The SDK dependency came in with task 4 (pinned `1.0.0-rc.9`, as alchemy resolves it).

### 4. Routing provider on the Cloudflare API client

**Change:**
- **Rewrite `mail/routing.ts` + `routing-api.ts`** on the SDK's `createDns` and `getDns` calls, keeping adopt, retain and the readiness wait:
  - readiness is `getDns({zoneId, subdomain})` returning no errors (null, missing or empty);
  - reconcile calls `createDns({zoneId, name})` only when that check isn't ready;
  - the attributes and the diff drop `subdomainId`;
  - the apex case uses the SDK's `getEmailRouting`.
- **Delete** the hand-written HTTP client and most of `routing.test.ts`, keeping behaviour tests on a fake SDK layer.

**Starts at:** `apps/server/src/mail/routing.ts`, `routing-api.ts`, `test/mail/routing.test.ts`.

**Verify:**
- Unit tests pass on the fake layer.
- In step 7, the real deploy adopts the existing `mail.schwarzmueller.sh` registration cleanly.
- **Fallback:** the SDK's routing settings type has no `subdomains` field. If adoption needs to see an existing registration, or `createDns` on a registered-but-not-ready name misbehaves, keep one small raw settings read and note it here.

**Done:** yes (2026-09-24), by a delegated agent; patch reviewed and integrated.
- `getEmailRouting` detects the apex case, `getDns({zoneId, subdomain})` decides readiness, and `createDns` runs only when not ready. Attributes are `{zoneId, name}`, and `routing-api.ts` is deleted. There are 6 behaviour tests on a fake SDK layer.
- No raw fallback was needed.
- Live-only unknowns for step 7: what `getDns` returns for a name that isn't registered, and whether a disabled registration with DNS still reads as ready.

### 5. CLI config, plus dead files

**Change:**
- **CLI config.** The CLI reads `UMAIL_URL` through Effect `Config`. Delete `CliEnvironment`, the env types in `packages/api-contract/src/client.ts`, and the `env` parameters threaded through login, logout, accessToken and decideApproval. Tests use `ConfigProvider.fromUnknown`.
- **Dead files** (the owner's cleanup request, not the ADR). Delete `scripts/generate-agentmail-icon.mjs` and `apps/server/src/api/brand/icon.png`, and keep `icon-bytes.ts`. In `mcp.test.ts`, keep the PNG-signature check and drop the byte-for-byte comparison to the file.
- **Sweep.** After tasks 1–4, grep for exports that are no longer used and for files nothing imports, then delete them.

**Verify:** the gates pass; the `--help` output is byte-identical apart from intended command changes; and `rg` finds no references to the deleted symbols or files.

**Done:** yes (2026-09-24).
- The CLI `Config` part was done in task 2. `UMAIL_URL` is read by `umailBaseUrl` in `@umail/api-contract/client`.
- Deleted the icon generator, `icon.png`, and the `scripts/` directory; `mcp.test.ts` keeps only the PNG signature check.
- Cleanup items the owner approved alongside the plan:
  - `packages/mail-content` folded into `apps/server/src/mail/html-{policy,parser}.ts`, with its specs moved into the server's worker and browser suites;
  - the two server worker test configs merged, and `bundleMailTestModules` deleted (task 1);
  - the dead `scripts/**/*.ts` and `tools/**/*.test.ts` include patterns removed.
- Kept `.oxfmtrc.json`: without it oxfmt warns "No config found" on every run.
- The sweep found no dead symbols and no unimported files. The only unimported module is the CLI's `bin.ts` entry.
- Local gitignored build outputs of the removed Workers deleted (about 1.3 GB), and so were `.vitest-attachments` and the cleanup prototypes. `dist/` is kept; the owner rebuilds it.

### 6. Docs

**Change:** update `README.md` and `docs/operations.md` for:
- the single Worker, the alarm-driven sending, and the removal of Recovery and the cron;
- access and consent scoping, `/clients` and revoke;
- the static CLI client and logout behaviour;
- forwarding set/remove;
- the new troubleshooting and log lines;
- the reset note.

Also tell the owner about the four `.env` keys nothing reads, but don't edit `.env`.

**Verify:** every documented CLI command exists in `--help`, and `rg` finds no stale names (Recovery, SendConsumer, MailSend, destinations, `canAdmin`).

**Done:** yes (2026-09-24).
- README covers sending, forwarding, logout, and consent-scoped MCP access.
- `docs/operations.md` has new "Sending and due work" and "Client access" sections, updated troubleshooting and log lines, backup ownership, and the ADR 0001 reset note.
- `forwarding set/remove`, `login` and `logout` are in `--help`, and no stale names remain.
- `.env` keys nothing reads (for the owner to remove by hand): `APPROVAL_ADMIN_EMAIL`, `BOOTSTRAP_SECRET`, `UMAIL_API_KEY`, `UMAIL_MCP_API_KEY`.

### 7. Commit, push, full teardown and redeploy

**Change:**
1. Commit and push `cleanup/codebase-refactor`.
2. Inventory the account: only `uMail/prod` exists.
3. Destroy with `--dry-run` first, then for real.
4. Delete the retained AuthDb and MailArchive by id; empty R2 first.
5. Re-inventory.
6. Deploy with `--dry-run` first, then for real.

**Verify (live):**
- `/login` returns 200, and `/mcp` returns 401 with `WWW-Authenticate`.
- The catch-all points to the new Worker.
- Routing adopted `mail.schwarzmueller.sh`.
- The store's alarm fires (Workers Logs): submit a test message through the CLI after the owner logs in, and confirm it reaches `accepted` within seconds.
- Forwarding to an unverified address records `failure`.
- **Owner steps:** sign in; `pnpm umail login`; re-connect MCP clients, choosing their scope on the consent screen; recreate the addresses and forwarding; `pnpm build:clients`.

**Done:** no

## Review

An independent adversarial review (2026-09-24) checked the three invariants this plan protects:
- **At-most-once sending:** clear.
- **Alarm re-arming:** clear.
- **Fail-closed access:** clear, provided task 7 recreates AuthDb. REST access is limited to `umail-cli` by resource links and the registration rules, so a surviving AuthDb would keep old dynamically registered REST clients.

Nothing needed changing.

## Open questions

None. The owner decided:
- forwarding to any email per address;
- scope chosen on the consent screen;
- one Worker;
- keep Cursor support, anti-slop and tsdown.
