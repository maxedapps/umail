# Plan for 0005: Errors that say what happened and what to do

- **Status:** In progress
- **ADR:** `adrs/0005-error-reporting.md`

## Goal

**Done when:**

- Every failure a person or agent can hit says what happened and what to do next:
  - REST responses, CLI output and MCP tool results;
  - web pages and the send outcomes shown in the console;
  - deploy output.
- Each finding in the appendix is either fixed by a task or skipped for the stated reason.
- There is one source of error wording. Each API error carries its `message` from where the cause is known, and every surface shows that message. No surface keeps its own translation table.
- Submissions are idempotent by construction, and retry guidance is precise.
- The console shows send state and forwarding failures truthfully: never "delivered", and never "not sent" for an uncertain outcome.
- Everything listed in **Deletions** is gone.
- `pnpm lint`, `pnpm typecheck` and the full `pnpm test` pass.
- The changed pages and CLI output have been checked by hand on a preview stage.

**Out of scope:**

- Removing the old operator account after an email change (WEB-9): a separate identity-lifecycle change.
- The deprecated `subdomain` query that `routing.ts` relies on.
- RFC 9457 `problem+json`.
- Migrating MCP to Effect's `McpServer`.
- New features.

**Working rules:**

- **Branch and worktree:** the branch is `error-reporting`, in a worktree.
- **Commits:** one per task, credited to the owner.
- **Formatting:** `pnpm fmt` only on the packages touched.
- **Checks:** every task runs the full `pnpm test`. After any change to `alchemy.run.ts`, `site.ts` or `resources.ts`, run the stack check: `node --import ./node_modules/alchemy/bin/register-oxc.js -e 'import("./alchemy.run.ts")'`.
- **Refactor aggressively:** delete the old path in the same task. Never keep both paths.

## Mechanisms (from docs research on the installed versions)

| Need | Mechanism | Source |
| --- | --- | --- |
| Error with status and message | `Schema.TaggedError<Self>()(tag, fields, { httpApiStatus })`, one class per status. A second status on the same class is ignored when encoding. | effect `Schema.ts:15207`, `HttpApiBuilder.ts:1130` |
| Errors on every endpoint | Declare them on an API middleware (`error:`), and call `.middleware(...)` after the last `.add`. The client decodes them typed. | `HttpApiEndpoint.ts:283`, `HttpApi.ts:100` |
| Request decode failure to a readable 400 | `HttpApiMiddleware.layerSchemaErrorTransform` with `SchemaIssue.makeFormatterStandardSchemaV1()`, first issue, `path.join(".")`. Kinds `Body`/`ResponseHeaders` stay `Effect.die` (500). | `HttpApiMiddleware.ts:466`, `SchemaIssue.ts:1026` |
| Client: an undeclared status | `HttpApiClient` reports it as `HttpClientError` with reason `DecodeError`. Map it once by `response.status`. Never add `filterStatusOk`. | `HttpApiClient.ts:1034` |
| CLI network cause | undici's `TransportError.cause.code`, or `cause.errors[0].code` for an `AggregateError` (ECONNREFUSED, ENOTFOUND, UND_ERR_CONNECT_TIMEOUT). | `NodeHttpClient.ts:146` |
| CLI rendering | Keep `disableErrorReporting: true`. `Command.provide(AppLive)` on the root command. `tapCause`: `Cause.findErrorOption` for one line, `Cause.hasDies` for `Cause.pretty`. `CliError` is already rendered by `runWith`. | `Command.ts:2272`, `:3095` |
| Error message from fields | Override the `message` getter on `Data.TaggedError`. | effect `Data.ts:1111` |
| Bounded retry | `retryTransient({ schedule: Schedule.exponential(…), times: n })`. Without both options it spins forever. | `HttpClient.ts:1111` |
| Deploy errors as one line | Mark the error class with `[UserFacingError] = true` (`alchemy/UserFacingError`). Map `ConfigError` into it, because alchemy's own `ConfigError` match fails on rc.112. | alchemy `Cli/commands/errors.ts:112-150` |
| Structured Worker logs | `Telemetry.layer(Logger.layer([Logger.consoleStructured]))` in both `App.make` and `AccountStoreLive`, plus `Effect.annotateLogs`. | alchemy `Telemetry.ts:425`, effect `Logger.ts:655` |
| MCP tool errors | `isError: true` with plain text. No `structuredContent` on errors. Unknown causes get a fixed text and a log (Effect `McpServer`'s model). | MCP spec 2025-11-25; SDK `mcp-*.mjs:1398` |
| MCP authorization | A revoked grant gets 401 `WWW-Authenticate: Bearer error="invalid_token", resource_metadata=…`. A grant without a policy gets 403. | MCP authorization spec, RFC 6750 §3.1 |
| Better Auth errors | OAuth routes: `{error, error_description}`. Core routes: `{message, code}`. Rate limit: 429 `{message}` with `X-Retry-After`. Sign-in is limited to 3 per 10 s. | better-auth `rate-limiter/index.mjs:64,302` |

## The API error family (task 1)

`packages/api-contract/src/errors.ts` holds six classes. They share the fields `{ code: Schema.String, message: Schema.String }` and the union type `ApiError`.

| Class (`_tag`) | Status | Codes used |
| --- | --- | --- |
| `InvalidRequest` | 400 | `invalid_request` (decode), `invalid_cursor`, `address_invalid`, `address_reserved`, `from_address_unknown`, `from_address_inactive`, `too_many_recipients`, `html_too_complex`, `html_unsafe`, `no_external_recipients`, `forwarding_rejected` |
| `Unauthenticated` | 401 | `token_invalid` |
| `NotPermitted` | 403 | `read_denied`, `send_denied`, `mailbox_forbidden`, `recipient_not_allowed`, `client_inactive`, `insufficient_scope` |
| `NotFound` | 404 | `thread_not_found`, `message_not_found`, `job_not_found`, `attachment_not_found`, `mailbox_not_found`, `source_not_found`, `client_not_found` (console only) |
| `Conflict` | 409 | `address_exists`, `request_id_reused`, `no_archived_source` |
| `Unavailable` | 502 | `archive_unavailable`, `cloudflare_unavailable`, `cloudflare_misconfigured` |

**Rules for `code` and `message`:**

- `code` is a plain string on the wire, so an older CLI still decodes a newer server. The server constructs errors through a typed `ApiErrorCode` union.
- `message` is written where the cause is known. It names the argument or id the caller supplied, says what to do, and never reveals other mailboxes, the allowlist, internals or raw input beyond the offending value.

## Deletions

| What | Where | Replaced by |
| --- | --- | --- |
| Every use of `HttpApiError.*`, and the `businessErrors`/`scopedErrors` arrays | `api-contract/src/api-spec.ts`, `principal-authorization.ts`, `apps/server/src/api/*`, `web/*` | the six classes |
| `ApiProblem`, `ArchiveTransportProblem`, `OutboundMessageHasNoSource` | `api-spec.ts` and their users | `InvalidRequest`, `Unavailable`, `Conflict` |
| Server-generated `requestId` fallback (`payload.requestId ?? …`) | `api/operations.ts:345` | required `requestId` |
| `failureMessage`'s tag switch, `GENERIC_FAILURE` variants, and the `{"error": …}` JSON wrapper | `api/mcp/tools.ts:69-89` | `ApiError` message pass-through, one `toolError` |
| `failureResponse`'s tag switch and the fixed "Request failed / could not be completed" copy | `web/session.ts:45-74` | status-headed page using the error's message |
| `JOB_STATES`, `jobExplanation`, and the approval page's duplicate state wording | `web/pages/compose.ts:150`, `web/pages/approval.ts:62-111` | `web/send-state.ts` |
| `"That address is not valid or already exists."` mapping | `web/pages/mailboxes.ts:240-250` | the API error's message |
| `OAuthProtocolError`, the closed `OAuthError` literal list, and `OAuthEndpointError` swallowing | `apps/cli/src/auth.ts` | step-aware OAuth errors |
| `formatCliError`'s `_tag` fallback | `apps/cli/src/main.ts` | the renderer in task 6 |
| The single "missing or insecure" credential error | `apps/cli/src/credential-store.ts` | an error with path and problem |
| "Could not complete the approval request." catch-all | `apps/cli/src/approvals.ts:75-97` | status-specific errors |

After the last task, `rg "HttpApiError|ApiProblem|ArchiveTransportProblem|OAuthProtocolError|JOB_STATES|GENERIC_FAILURE" apps packages` returns nothing.

## Tasks

### 1. Swap in the error family across every raise site and caller

HttpApi type-checks each handler's errors against its endpoint's declared errors. The swap therefore has to happen in one task: the contract, every server raise site and every caller, so that everything compiles and passes. Messages in this task can be short but true ("Thread <id> was not found."). Task 2 adds the reasons.

**Start in:** `packages/api-contract/src/`, then follow `pnpm typecheck` through `apps/server` and `apps/cli`.

- **Errors:** add `errors.ts` with the six classes, `ApiErrorCode` and the `ApiError` union. Export them from `index.ts`.
- **Endpoint errors:** rewrite them in `api-spec.ts`, declaring each endpoint's real subset. `PrincipalAuthorization` declares `Unauthenticated` and `NotPermitted`.
- **Delete** `ApiProblem`, `ArchiveTransportProblem`, `OutboundMessageHasNoSource` and every `HttpApiError.*` import.
- **Replace all raise sites and callers:**
  - `api/operations.ts`, `principal.ts`, `auth/verify.ts`, `approval-http.ts`, `api/app.ts`;
  - the web routes that raise `NotFound` directly;
  - `tools.ts` (`Schema.is(ApiProblem)` becomes an `ApiError` pass-through);
  - `compose.ts` (`catchTag("ApiProblem")`);
  - `mailboxes.ts` (`catchTag(["BadRequest","Conflict"])`);
  - `session.ts` (`failureResponse` shows the `ApiError`'s message).
- **Validation errors:** add the `RequestErrors` middleware class, `error: InvalidRequest`. Call `.middleware(RequestErrors)` after the last `.add`.
  - On the server, `api/app.ts` provides `HttpApiMiddleware.layerSchemaErrorTransform(RequestErrors, …)`. `Params`/`Query`/`Payload` become `InvalidRequest{code:"invalid_request", message:"Invalid payload: to.0.address: Expected a bare address like name@example.com"}`. `Body`/`ResponseHeaders` stay `Effect.die`.
  - Improve the schema messages this surfaces:
    - `mail-contact.ts`: expect a bare address like `name@example.com`, lowercase domain, no display name.
    - `SubmitMessagePayload` union: `expected: 'a compose or reply submission (intent: "compose" | "reply")'`.
    - Non-empty `to`: "at least one recipient".
- **`requestId`:** required in `SubmitMessagePayload`. Delete the server fallback at `operations.ts:345`. The CLI already always sends one, and the console form already has one.
  - The **encoded** pattern accepts any-case hex, and a transform lower-cases it. MCP validates arguments against the JSON Schema generated from the encoded side before our decode runs, so a lowercase-only pattern there would reject upper-case ids.
  - The description says a retry must reuse both the id and the content.
- **Tests that pin today's wire format change here:**
  - the CLI's printed `NotFound` (`cli.test.ts` ~1452), which now prints the server's message;
  - the MCP message assertions;
  - `api.test.ts` 4xx bodies;
  - `mcp.test.ts`, `static-client.test.ts`, `approval-flow.test.ts` as they fail.

**Verify:**

- `pnpm typecheck` passes.
- **New `api-contract` tests:**
  - error encode and decode round trip;
  - `requestId` normalization;
  - the improved address, intent and recipient messages.
- **`test/api/api.test.ts`:**
  - `POST /submissions` without a body, and with a malformed `to`, returns 400 `InvalidRequest` with the path message;
  - malformed JSON returns 400;
  - a handler returning an invalid success body returns 500, not 400. Add one small test route if none exists;
  - a missing `requestId` returns 400.
- **MCP test:** an upper-case `requestId` is accepted and stored lower-cased.
- Full `pnpm test`.

**Done:** yes.

- Each error class narrows its constructor to its own codes (`Props<NotFoundCode>`); `code` stays `Schema.String` on the wire.
- Endpoints declare `[NotFound, Conflict]` (every store call can raise them), plus `Unavailable` for forwarding, attachments and message source. `InvalidRequest`, `Unauthenticated` and `NotPermitted` come from the two API middlewares, which HttpApi applies to every endpoint.
- **Deviation:** a response that fails to encode dies with the bare `SchemaError`, not the `HttpApiSchemaError`, because the latter is itself respondable and would still render as an empty 400.
- **Deviation:** the console's client pages raise `NotFound` `client_not_found`, a code the table did not list.

### 2. Reasons and messages where the cause is known

**Start in:** `apps/server/src/api/operations.ts`, `account/jobs.ts`, `api/destinations.ts`.

- **`storeCall`:** maps each store error to an `ApiError` with a message.
  - `JobAuthorizationError` carries `addresses` (the rejected recipients only), set in `account/jobs.ts:authorizeOutbound`. It maps to `NotPermitted` with one of these messages:
    - `recipient_not_allowed`: "Recipients not allowed for this client: a@x, b@y. Remove them, or ask the operator to allow them."
    - `mailbox_forbidden`: "This client may not send from mailbox <id>. Use a sending identity it is allowed to use."
    - `send_denied`: "This client may not send mail."
    - `client_inactive`: "This client's access was revoked."
  - `ThreadNotFoundError` becomes `NotFound`, `thread_not_found`, naming the id.
  - `AccountConflictError` becomes `Conflict`, `address_exists`: "<local>@<domain> already exists."
  - `SubmissionConflictError` becomes `Conflict`, `request_id_reused`: "requestId <id> was already used for different content. Resubmitting the same content returns the existing job; use a new requestId for a new message."
- **`requireRead`/`requireSend`:** fail with `NotPermitted` `read_denied` ("This client has no read access.") or `send_denied`.
- **404s:** every `NotFound` names the id and says "or it is outside this client's access". That covers message, job, attachment, reply parent and archive source. The archive-missing case uses `source_not_found`.
- **`createAddress`:** call `constructMailboxAddress` before the store call.
  - `invalid`: `address_invalid`, "Use only letters, digits, '.', '_' and '-'."
  - `reserved`: `address_reserved`, "\"admin\" is reserved for mail-system use. Choose another name."
- **Sender address:** the from-address check separates `from_address_unknown` from `from_address_inactive` (via `getAddress`). Both messages point to the sending-identities listing.
- **Other `InvalidRequest` cases:**
  - Cursor decode: `invalid_cursor`, "Pass nextCursor from the previous page unchanged, or omit it."
  - HTML policy: `MailHtmlPolicyError` carries its `limit`. `html_too_complex` says "The HTML body exceeds the <limit> limit. Simplify it or send text only."; `html_unsafe` says "The HTML body could not be sanitized. Send text only."
  - Reply with no external recipient: `no_external_recipients`, "all participants are this account's own addresses; use a new message with explicit recipients."
- **`listMessages` with an `addressId`:** an unknown or inaccessible id fails with `NotFound` `mailbox_not_found`, using the same wording for both. A valid mailbox with no matches still returns an empty page. Describe `addressId` in the contract: "a mailbox id from the sending-identities listing, not an email address".
- **`api/destinations.ts`:** classify by the runtime `_tag` of distilled's errors, with a default branch, and log the detail.
  - `BadRequest`, `UnprocessableEntity`, `Conflict`: `InvalidRequest` `forwarding_rejected`, with Cloudflare's message.
  - `TooManyRequests`: `Unavailable` `cloudflare_unavailable`, with Cloudflare's message (e.g. "Verification email has been sent too recently") plus " Try again later."
  - `Unauthorized`, `Forbidden`, `InvalidRoute`, `NotFound`, `ConfigError`: `Unavailable` `cloudflare_misconfigured`, "Cloudflare refused CF_EMAIL_ROUTING_TOKEN. Give it Email Routing Addresses edit access on this account and redeploy."
  - Everything else: `Unavailable` `cloudflare_unavailable`, "Cloudflare Email Routing is unavailable. Try again."
  - Give the call a short distilled retry policy (`Retry.none`, or at most one retry). The default retries auth errors and 429s for about 20 s inside the request, which would hang the form.
- **`auth/verify.ts`:** 401 `Unauthenticated` `token_invalid`, "The access token is invalid or expired. Run: umail login". A missing scope becomes 403 `NotPermitted` `insufficient_scope`.

**Verify:**

- **`test/api/api.test.ts`** asserts status, `code` and `message` for:
  - a recipient not on the allowlist;
  - a disallowed mailbox;
  - no read access;
  - send denied;
  - an unknown thread, message or job;
  - a reserved, an invalid and a duplicate address;
  - a reused `requestId`;
  - a bad cursor;
  - an out-of-scope `addressId`;
  - an HTML limit;
  - an inactive sender.
- **`test/api/destinations.test.ts`:** one case for each classification, including a 429 that keeps Cloudflare's message.
- **`test/account/*.worker.spec.ts`:** `JobAuthorizationError.addresses` lists only the rejected recipients.
- Full `pnpm test`.

**Done:** yes.

- `AccountConflictError` now carries the duplicate `address` instead of a generated id, so the 409 can name it.
- `DestinationsClient.ensure` fails with `InvalidRequest`/`Unavailable` directly; `DestinationError` is gone. The call runs under distilled's `Retry.none`.
- The store's own `mailbox_forbidden` (reached only when a mailbox changes mid-request) says "this mailbox"; the API's check before it names the id.
- `MailHtmlPolicyError` gains an optional `limit`; `describeMailHtmlLimit` turns it into "128-level nesting" and so on.
- `insufficient_scope` is mapped in `verify.ts` but not tested at the REST edge: the test world cannot mint a signed token without `umail:access`.

### 3. MCP: pass messages through, safe defects, correct authorization responses

**Start in:** `apps/server/src/api/mcp/tools.ts` and `route.ts`, and `auth/oauth-resource.ts`.

- **Tool results:**
  - One `toolError(text)` builds `{ content: [{type:"text", text}], isError: true }`.
  - An `ApiError` failure shows its `message` (pass-through from task 1).
  - Any other failure, defect or interrupt goes through `catchCause`, which logs with `Effect.annotateLogs({ tool, clientId })` and returns "The AgentMail tool failed unexpectedly."
  - For `umail_send_message` and `umail_reply_to_message` the fallback adds: "The message may or may not have been queued. Resubmit with the same requestId and content to get the existing job; it will never send twice."
- **Tool descriptions:** the send and reply tools say `requestId` is required (any-case UUID) and must be reused for retries.
- **Authorization:**
  - `mcpPrincipalForAccess` distinguishes a missing consent from a consent without a policy.
  - A missing consent (revoked) gets 401 with `Bearer error="invalid_token", resource_metadata=…, scope=…`.
  - A consent without a policy gets 403 with "This client is connected but has no access policy. Ask the operator to configure it under Clients."
  - `oauth-resource.ts` adds `error="invalid_token"` for present-but-invalid tokens. A missing token keeps the plain challenge.

**Verify:**

- **`test/api/mcp.test.ts`, `mcp-scope.test.ts`:**
  - a rejected recipient's text names it;
  - a missing thread names its id;
  - a defect returns the fixed text and logs;
  - a send without `requestId` fails input validation;
  - a revoked client gets 401 with `invalid_token` (replaces the current 403 assertion at `mcp.test.ts:279`).
- Full `pnpm test`.

**Done:** yes.

- `Access.mcpGrant` tells no grant (`none`), a consent without a policy, and a policy apart; `mcpPolicy` is derived from it. A token from someone other than the operator is treated as revoked.
- Only a request that sent a `Bearer` token is told `invalid_token`; no token or another scheme gets the plain challenge (RFC 6750 §3.1).
- The send fallback is chosen by the tool's `destructiveHint`, which only the two send tools set.
- Extra test: a send that dies returns the unknown-outcome retry text.

### 4. Truthful send outcomes and structured logs

**Start in:** `apps/server/src/mail/email-sender.ts`, `account/jobs.ts`, `api/projection.ts`, `web/pages/mail.ts`.

- **Provider failures:**
  - `classifyProviderFailure` keeps a detail for both outcomes: the `code` plus the message truncated to 300 characters, without the stack.
  - `E_DELIVERY_FAILED` moves from `REJECTED_CODES` to `unknown`.
  - `CompleteAttemptOutcome`'s `unknown` gains `failureDetail`, and `completeAttempt` stores it.
  - Dispatch logs the failed attempt with `annotateLogs({ jobId })`.
- **Projection:** `sendError` becomes `class: detail` when there is a detail.
- **New `web/send-state.ts`** is the single vocabulary for job state and failure text, used by the sent page, the approval page and the conversation:
  - **States:** Queued, Waiting for approval, Sending, Accepted by Cloudflare, Not sent, Outcome unknown.
  - **Failure classes:**
    - denied: "The request was denied."
    - expired: "Nobody approved it within 24 hours."
    - cancelled: "It was withdrawn before sending (its conversation was deleted)."
    - notification_failed: "The approval email to the operator could not be sent."
    - policy: "It was blocked before sending."
    - provider: "Cloudflare rejected it."
    - A detail is appended in parentheses.
  - **Unknown:** "AgentMail cannot confirm whether it was sent and will not retry it. Ask the recipient before sending it again."
  - **Accepted:** "Cloudflare accepted it for delivery; delivery to the recipient is not confirmed."
- **Conversation (`openMessageHtml` and `collapsedMessageHtml`):**
  - An outbound message shows its state badge unless `accepted`.
  - An inbound message with `forwardOutcome === "failure"` shows "Forwarding to <destination> failed."
- **Structured logs:** `Telemetry.layer(Logger.layer([Logger.consoleStructured]))` goes in `app.ts` (`App.make` provide) and `account/worker.ts` (`AccountStoreLive`).

**Verify:**

- **`test/mail/email-sender.test.ts`:** unknown keeps the detail, and `E_DELIVERY_FAILED` is unknown.
- **`test/account/jobs.worker.spec.ts`:** the unknown detail is stored.
- **`test/web/mail.test.ts`:** a rejected reply shows "Not sent", and a failed forward shows its note.
- **Browser spec:** extend the `mail-thread` fixture with a rejected reply. It must show no CSP violations and no overflow at 320 px.
- Full `pnpm test`.

**Done:** yes.

- A provider detail is `code: message` (or the message alone when it already names the code), capped at 300 characters. An `unknown` job keeps `failure_class` null, so its `sendError` is the detail alone.
- The conversation shows the badge only; the full explanation stays on the sent page. An inbound message whose forward failed shows the note when open and a "Forwarding failed" badge when collapsed.
- The approval page, once decided, reads "You approved this email" with the shared badge and explanation.
- `StructuredLogs` is defined once in `app-runtime.ts` and provided on both Workers.
- The browser fixture opens the inbound message (`?open=m-thread`), so the rejected reply shows as a collapsed row.

### 5. Web pages

**Start in:** `apps/server/src/web/session.ts`, then `pages/*`.

- **`failurePage(status, message)`:** the heading comes from the status: "Invalid request", "Sign-in required", "Not allowed", "Not found", "Conflict", "Service unavailable" or "Server error".
  - An `ApiError` shows its own message.
  - `withOperator` gets `Effect.catchDefect`, which logs the error and renders a 500 "AgentMail failed while handling this page. Reload to retry; the Worker logs have the details." There are no more blank 500s.
  - The page gets a "Back to Mail" link.
- **Login script (`login.ts`):**
  - 401: "Wrong email or password."
  - 429: "Too many sign-in attempts. Wait N seconds and try again.", using `X-Retry-After`.
  - Other statuses: "Could not sign in (HTTP <status>): <message>."
  - Network failure: "Could not reach AgentMail. Check your connection and try again."
- **Consent script:** use `message ?? error_description`. "missing oauth query" becomes "This consent request expired or is incomplete. Start the connection again from the client."
- **Device pages:** a separate message for each case.
  - Unsupported access: "…asks for access AgentMail does not grant."
  - Invalid or expired code: "…run `umail login` again for a new code."
  - Already processed: "…was already approved or denied."
- **Approval gone page:** the state is passed through. It says the review link can no longer be used, and gives the decision when one is known ("You approved it" / "You denied it; it was not sent"). It points to the conversation for the send state and never guesses whether the email was sent.
- **Mailboxes:**
  - The create form shows the error's message under the address field.
  - The forwarding form shows `InvalidRequest` under the field, and `Unavailable` as an error flash.

**Verify:**

- **`test/web/*.test.ts`:**
  - a reserved address shows its message;
  - a Cloudflare misconfiguration shows the flash, not the field error;
  - a 404 page has the "Not found" heading and the error's message;
  - a defect renders the 500 page.
- **Browser spec, login fixture:** a stubbed 429 shows the wait message.
- Full `pnpm test`.

**Done:** no.

### 6. CLI

**Start in:** `apps/cli/src/`.

- **New `errors.ts`:** `Data.TaggedError` classes with computed `message` getters.
  - `ServerUnreachable {origin, step, code?}`: "Could not reach <origin> during <step> (ECONNREFUSED). Check that the server is up and UMAIL_URL is right."
  - `ServerFailed {status, method, path}`: "The umail server failed (HTTP 503) on GET /threads. Try again later." For 429: "Rate limited; try again shortly."
  - `UnexpectedResponse {method, path, detail}`: "Unexpected response from the umail server (GET /threads): <one-line schema issue>. Update the CLI or check UMAIL_URL."
  - One `fromHttpClientError` maps reasons: `TransportError` becomes `ServerUnreachable`, using `cause.code ?? cause.errors[0].code`; undeclared statuses become `ServerFailed`. The API client and the OAuth requests both use it.
- **`auth.ts`:**
  - `OAuthProtocolError` becomes `OAuthFailed {step, detail}`, where `step` is one of discovery, device authorization, sign-in approval, token refresh or revocation. `detail` is the status plus `error: error_description`, or the failed check, e.g. "issuer is https://a/api/auth, expected https://b/api/auth".
  - The OAuth error schema accepts any `error` string plus an optional description.
  - `invalid_grant` and `invalid_client` still mean "login required".
  - A scope or origin mismatch in the stored credentials becomes `LoginRequired` with the reason ("Stored credentials are for <origin>…").
  - Device polling retries transport errors with a bounded `retryTransient` (`times: 3`, exponential schedule).
- **`credential-store.ts`:** `CredentialFileError {path, problem}` for mode 644 (suggest `chmod 600`), directory mode 755 (suggest `chmod 700`), a symlink or wrong owner, corrupt JSON (delete it and run `umail login`), and a write failure with the platform error.
- **`approvals.ts`:**
  - 404: "This approval token is not recognized."
  - 410: "This approval is no longer available."
  - Transport and 5xx go through `fromHttpClientError`.
  - The token and URL stay hidden, as the existing tests require.
- **`commands/index.ts`, submit:** when the outcome is unknown (`ServerUnreachable` or `ServerFailed` after the retries), append "The submission may have been accepted. Retry with --request-id <id> and the same content to get the existing job."
- **`main.ts`/`runtime.ts`:**
  - `Command.provide(AppLive)` on the root command. `NodeServices` stays outside.
  - One `tapCause` renderer: an `ApiError` or a CLI error prints `umail: <message>`; a defect or an empty failure prints `Cause.pretty`; a `CliError` is skipped.
  - Keep `disableErrorReporting: true`.
  - A missing HOME/XDG_STATE_HOME now reports "Set HOME or XDG_STATE_HOME to locate umail credentials."
  - `UMAIL_URL` errors echo the value and the rule.

**Verify:**

- **`apps/cli/test/cli.test.ts`,** using the existing fake `HttpClient.make`, asserts the printed text for:
  - connection refused during login;
  - `server_error` on refresh;
  - an issuer mismatch;
  - an undeclared 503;
  - a declared 403 with its message;
  - a 401 ("Run: umail login");
  - a schema mismatch;
  - credential mode 644;
  - HOME unset;
  - approval 404 and 410;
  - an unknown-outcome submission printing `--request-id`.
- **Update `cli.test.ts:1144-1232`**, the approval safe-error tests, to the new messages. They must still leak no URL or token.
- Full `pnpm test`.

**Done:** no.

### 7. Deploy errors and inbound diagnostics

**Start in:** `alchemy.run.ts`, `apps/server/src/site.ts`, `mail/routing.ts`, `mail/process-index.ts`.

- **`DeployConfigError`** is a `Data.TaggedError` with `[UserFacingError] = true`. `alchemy.run.ts` maps `ConfigError` into it: "UMAIL_DOMAIN is missing. Set it in .env."
- **`site.ts`:**
  - `UMAIL_DOMAIN` must be a bare hostname: "UMAIL_DOMAIN must be a hostname like mail.example.com (no scheme, path or port)".
  - `UMAIL_OPERATOR_PASSWORD` is validated here (at least 12 characters, `Schema.Redacted`) and read in `AuthProvision`'s init, not its runner, so a bad value fails before anything changes.
  - The existing plain `throw`s in `site.ts` become `DeployConfigError`.
- **`routing.ts`:**
  - `inspect` returns the missing records from `dns.errors`.
  - `EmailRoutingDomainNotReady` is marked `UserFacingError`: "Email Routing DNS for <name> is not ready after 60 s. Missing: MX <name> → route1.mx.cloudflare.net (priority 1); … Check for conflicting MX/TXT records."
  - Polling calls `session.note`.
- **`process-index.ts`:** the content-policy log carries `from`, `to` and the MIME error `detail`.

**Verify:**

- **`tests/stack.test.ts`:**
  - a hostname with a scheme fails with the message;
  - a short password fails at evaluation.
- **`test/mail/routing.test.ts`:** the not-ready message lists the missing record.
- **Manual:** run the stack check and `alchemy deploy --stage prod --dry-run` with `UMAIL_DOMAIN=https://x` in a temporary env. It must print one line.
- Full `pnpm test`.

**Done:** no.

### 8. Docs, sweep, live verification

- **Docs:**
  - README: requests need a `requestId`, and the CLI error messages.
  - `docs/operations.md`: Workers Logs are structured JSON with `jobId`, `tool` and `clientId`, and what `unknown` means.
- **Sweep:** the `rg` from **Deletions** returns nothing. Lint shows no unused exports.
- **Live check** on a `pr-<n>` preview:
  - **agent-browser**, light and dark, 1440 px and 320 px:
    - a rejected reply and a failed forward in the conversation;
    - the error page;
    - login after 4 fast wrong attempts (the 429 message);
    - a reserved mailbox;
    - an expired approval link.
  - **CLI against the preview:** a wrong `UMAIL_URL` port, `threads get --id nope`, a reused `--request-id` with changed content.
  - **MCP:** a raw JSON-RPC `tools/call` against the preview with a disallowed recipient.
  - **Workers Logs:** query the preview's logs. Confirm that a failed send attempt and an MCP defect arrive as one structured entry with `jobId`/`tool`/`clientId` as fields, including from the Durable Object, and at an error level rather than "log". If either is off, fix it with a small custom logger before merging.
  - **Teardown:** destroy the preview (automatic since PR #3), then remove its routing entry in the dashboard.
- **Review:** review the full diff once (code-review).

**Verify:** `pnpm fmt` on the touched packages, `pnpm lint`, `pnpm typecheck`, the full `pnpm test`, and the live checks above.

**Done:** no.

## Owner's manual QA after deploy

- Send yourself a reply with the CLI while the network is down, and check the printed `--request-id` hint.
- Open a conversation with an outbound message and check its state badge.
- Revoke an MCP client, then call a tool from it; it should re-authorize.

## Decided questions

The owner approved the plan with both recommendations on 2026-09-26:

1. **`E_DELIVERY_FAILED` becomes `unknown`.** Cloudflare documents it as a recipient-server rejection, and it may be partial across recipients. Calling it "not sent" invites a duplicate.
2. **Password check at stack evaluation.** `plan`, `destroy` and stack tests need `UMAIL_OPERATOR_PASSWORD` set, so a bad value fails before any change.

## Appendix: every finding and its decision

The IDs are the audit's. "Free" means the shared error family fixes it without extra code.

| ID | Finding | Decision |
| --- | --- | --- |
| CLI-1 | `OAuthProtocolError` covers 13 causes | Task 6 |
| CLI-2 | API errors print as bare tags | Tasks 1–2 (messages), task 6 (renderer) |
| CLI-3 | Undeclared 5xx prints "Decode error" | Task 6 |
| CLI-4 | Credential-file errors merged | Task 6 |
| CLI-5 | Local scope check blamed on the server | Task 6 |
| CLI-6 | Transport errors drop the cause | Task 6 |
| CLI-7 | Raw schema parse tree printed | Task 6 |
| CLI-8 | Approvals: one message for everything | Task 6 |
| CLI-9 | Setup failures exit silently | Task 6 |
| CLI-10 | Lock timeout has no path | **Skip:** it needs two concurrent CLI refreshes, and the message already says what happened |
| CLI-11 | Revocation failure drops the reason | Task 6 (the OAuth detail carries it) |
| CLI-12 | `UMAIL_URL` error doesn't echo the value | Task 6 |
| CLI-13 | Credentials for another origin not explained | Task 6 |
| CLI-14 | `--output` write errors show internal names | **Skip:** rare, and the path is already shown |
| API-1 | Policy denials merged | Task 2 |
| API-2 | Empty 400 on validation | Task 1 |
| API-3 | Address create: bare BadRequest/Conflict | Task 2 |
| API-4 | Unknown provider failure dropped | Task 4 |
| API-5 | HTML limits merged | Task 2 |
| API-6 | Forwarding: Cloudflare faults as 400 | Task 2 |
| API-7 | From address unknown vs inactive | Task 2 |
| API-8 | `sendError` drops the detail | Task 4 |
| API-9 | Bare 401 | Task 2 |
| API-10 | MCP 403 for revoked or no policy | Task 3 |
| API-11 | Bare 409 on reused `requestId` | Task 2 |
| API-12 | Bad cursor is a bare 400 | Task 2 |
| API-13 | MCP drops the archive message | Free (task 3 pass-through) |
| API-14 | Reply-parent 404 is ambiguous | Task 2 |
| API-15 | Out-of-scope `addressId` returns an empty page | Task 2 (decided: `NotFound`, same wording for unknown ids) |
| API-16 | Approval gone page is vague | Task 5 |
| API-17 | Archive-missing 404 is ambiguous | Free (task 2 `source_not_found` message) |
| API-18 | Recipient cap doesn't give the count | **Skip:** the cap is stated, and counting is trivial for the caller |
| MCP-1 | Policy denials merged | Task 2 |
| MCP-2 | Not-found without id or scope hint | Task 2 |
| MCP-3 | Email-shaped `addressId` returns an empty page | Task 2 |
| MCP-4 | Send defect gives no retry guidance | Tasks 1 and 3 (`requestId` required plus fallback text) |
| MCP-5 | `/mcp` 403 for two causes | Task 3 |
| MCP-6 | Bad cursor gives generic text | Free (task 2 plus the task 3 pass-through) |
| MCP-7 | Archive outage gives generic text | Free |
| MCP-8 | Unknown `fromAddressId` has no next step | Task 2 |
| MCP-9 | Misleading "no recipients" | Task 2 |
| MCP-10 | Address validation message is vague | Task 1 |
| MCP-11 | `requestId` pattern is case-strict | Task 1 |
| MCP-12 | Sending identities listed to deny-mode clients | **Skip:** the send attempt now gets a precise `send_denied` |
| MCP-13 | `approval_required` rejection reads as waiting | **Skip:** `send-state.ts` renders `rejected` as "Not sent", and the MCP job state is already `rejected` |
| WEB-1 | Conversation hides send state and forward failures | Task 4 |
| WEB-2 | Bad Cloudflare token shown as a field error | Tasks 2 and 5 |
| WEB-3 | Login blames the password on a 429 | Task 5 |
| WEB-4 | Mailbox create merges causes | Tasks 2 and 5 |
| WEB-5 | Generic error page; blank 500 | Task 5 |
| WEB-6 | Approval gone page misstates the outcome | Task 5 |
| WEB-7 | Consent drops `error_description` | Task 5 |
| WEB-8 | Device pages merge causes | Task 5 |
| WEB-9 | Signed in as a non-operator | **Out of scope:** a separate identity-lifecycle change (old operator account removal) |
| MAIL-1 | Unknown send outcome keeps no cause | Task 4 |
| MAIL-2 | Failure reasons shown as raw codes | Task 4 |
| MAIL-3 | Inbound content rejections logged without context | Task 7 |
| MAIL-4 | HTML rejection reason dropped | Task 2 (same as API-5) |
| DEPLOY-1 | Routing not-ready drops the DNS diagnosis | Task 7 |
| DEPLOY-2 | `UMAIL_DOMAIN` accepts a scheme or path | Task 7 |
| DEPLOY-3 | Password length checked late, as a defect | Task 7 |
