# 0005: Errors that say what happened and what to do

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

A four-surface audit on 2026-09-25 found 61 error-message defects. It covered the CLI, the REST API, the MCP tools, and the web, mail and deploy paths. A second reviewer reproduced the key ones. They come from five root causes:

1. **The server erases reasons it knows.**
   - `storeCall` and `requireRead`/`requireSend` turn precise store errors (`recipient_not_allowed`, `mailbox_forbidden`, a duplicate address, a reused `requestId`) into Effect's built-in `HttpApiError.*`. Those classes only encode `{"_tag":"Forbidden"}`, with no message.
   - Request-schema failures die as `HttpApiSchemaError` and become an **empty** 400.
   - The CLI then prints `Forbidden`. MCP agents get "The request is not permitted." for five different causes.
2. **The CLI merges failures into one class.**
   - `OAuthProtocolError` covers 13 causes, including connection refused, with "The OAuth server returned an invalid response."
   - Undeclared statuses print as `Decode error (500 …)`.
   - Setup failures exit silently.
3. **Send outcomes lose evidence and the console hides them.**
   - An unrecognized provider failure becomes `unknown` with no stored or logged cause.
   - The conversation view ignores `sendState` and `forwardOutcome`, so a rejected reply looks like any other message.
4. **Retries are unsafe.** `requestId` is optional. A caller whose first response is lost cannot retry idempotently, and our advice to "retry with the same requestId" is useless when none was sent.
5. **Web and deploy copy is generic or wrong:**
   - login blames the password on a 429;
   - the expired approval page guesses at the email's fate;
   - a broken Cloudflare token shows as a field error;
   - config errors print raw `SchemaError` trees.

The docs research on the installed versions (effect 4.0.0-rc.112, alchemy 2.0.0-beta.77, better-auth 1.7.2, @modelcontextprotocol/server 2.0.0) settled the mechanisms:
- Built-in `HttpApiError` classes cannot carry a message.
- One error class cannot serve several statuses.
- `HttpApiMiddleware.layerSchemaErrorTransform` is the supported hook for decode failures.
- `SchemaIssue.makeFormatterStandardSchemaV1` gives a one-line `path: message`.
- alchemy prints errors marked `UserFacingError` as one line.
- Effect's own `McpServer` keeps sessions in memory, so it is unfit for a stateless Worker.

We are in early development: breaking wire and CLI changes are fine.

## Decision

1. **One small family of API errors in `@umail/api-contract`.** Six `Schema.TaggedError` classes, one per status: `InvalidRequest` 400, `Unauthenticated` 401, `NotPermitted` 403, `NotFound` 404, `Conflict` 409 and `Unavailable` 502.
   - Each carries `{ code, message }`. `code` is a stable reason (`recipient_not_allowed`, `address_reserved`, …). `message` is a safe, actionable sentence written where the cause is known.
   - They replace every `HttpApiError.*`, as well as `ApiProblem`, `ArchiveTransportProblem` and `OutboundMessageHasNoSource`.
   - The server, the CLI, the MCP tools and the web pages all show `message` as is. None keeps its own translation table.
2. **Readable validation errors.** A `RequestErrors` API middleware declares `InvalidRequest`. Its `layerSchemaErrorTransform` turns request decode failures into `Invalid payload: to.0.address: …`. A failing response encode stays a 500.
3. **Idempotent submissions by construction.** `requestId` is required on every submission, and any UUID case is accepted and lower-cased. Retry guidance says it precisely: repeating a submission returns the existing job and never sends again. The CLI prints its generated id when a submission's outcome is unknown.
4. **Truthful send state.**
   - A provider failure keeps its code and a short detail on the job, including when the outcome is `unknown`, and is logged with the job id.
   - `E_DELIVERY_FAILED` becomes `unknown`. It is a recipient-server rejection that may be partial across recipients.
   - The console shows each outbound message's state and each failed forward. It uses one shared vocabulary: queued, waiting for approval, sending, accepted by Cloudflare, not sent, outcome unknown. It never says "delivered", and never says "not sent" for an uncertain outcome.
5. **Our own errors are public and anything else is generic.** MCP returns an `ApiError` message as plain `isError` text. Defects return a fixed text and are logged with tool and client context through structured Worker logs (`Telemetry.layer(Logger.layer([Logger.consoleStructured]))`).
   - A revoked MCP grant gets 401 `invalid_token`, so clients re-authorize.
   - A grant without a policy gets a 403 with a message.
6. **The CLI names the step, the cause and the next action.**
   - Transport, HTTP-status, OAuth-error and malformed-response failures are separate errors with computed messages: which step failed, what came back (network code, status, OAuth `error_description`) and what to do.
   - One renderer prints one line for expected errors and `Cause.pretty` for defects. Setup layers are provided to the root command, so their failures are reported.
7. **Deploy errors are one actionable line.** Config errors and the routing-readiness failure are raised as alchemy `UserFacingError`s that name the variable, the rule or the missing DNS record.

## Alternatives

| Option | Why not |
| --- | --- |
| **Simplest: add messages to the few places users hit, keep `HttpApiError` and per-surface wording** | The built-ins cannot carry a message, so the CLI and MCP would keep inventing their own text from `_tag`, three translations of one fact. This fixes symptoms and grows the code. |
| One `ApiError` class with a `status` field | HttpApi encodes an error class with the first status declared for it, so one class cannot serve several statuses. This was tested on rc.112. |
| RFC 9457 `application/problem+json` | The only consumer is our own `HttpApiClient`, which needs `_tag`. `type`/`title`/`detail` add fields for no reader. |
| Migrate MCP to Effect's `McpServer` | Its HTTP layer keeps sessions in an in-memory map, and stateless mode is a TODO. That breaks across Worker isolates. We copy its error model instead. |
| Keep `requestId` optional and document retries | A lost first response still cannot be retried safely, which is the case that matters. |
| Keep `E_DELIVERY_FAILED` as "not sent" | It may follow partial delivery, and calling it "not sent" invites a duplicate. |

## Consequences

- **Breaking changes:**
  - Error bodies change from `{_tag}` to `{_tag, code, message}`.
  - `requestId` becomes required.
  - An unknown or out-of-scope `addressId` filter becomes a `NotFound` instead of an empty page. A valid mailbox with no mail still returns an empty page.
  - The CLI and server ship together, so no compatibility shim is needed.
- **Messages become part of the contract and its tests.** Wording changes touch tests. That is the point: each test pins a real sentence a user reads.
- **Policy messages reveal only what the caller supplied or may read:** a rejected recipient, the chosen mailbox, a disabled capability. Never the whole allowlist or other mailboxes. Unknown and inaccessible ids get the same wording.
- **Deploy-time checks need the variables present.** Validating `UMAIL_OPERATOR_PASSWORD` when the stack is evaluated means `plan` and `destroy` also need it set. `.env` already has it.
- **Structured logs change the Workers Logs format** from pretty text lines to one JSON object per log, with the annotations as fields.
- **Out of scope:**
  - removing the previous operator's account when `UMAIL_OPERATOR_EMAIL` changes (a separate identity-lifecycle change);
  - the deprecated `subdomain` parameter that `routing.ts` relies on.
