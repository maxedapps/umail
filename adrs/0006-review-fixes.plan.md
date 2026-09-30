# Plan for 0006: Fix the code review of main b47d065

- **Status:** Done (code review: one finding, fixed)
- **Source:** `~/agent-reports/umail-code-review.md` (bugs 1–3, simplifications 4–7, item 8 in touched modules)
- **ADR:** none. Every task follows an existing ADR decision; none makes a new design choice.

## Goal

**Done when:**

- A deactivated mailbox sends nothing, including mail already queued or released by a later approval.
- An identical reply retry returns the existing job before and after the parent is accepted.
- The console shows every message of a conversation, however long.
- Simplifications 4, 5, 5b, 6 and 7 are done, and item 8 in the modules this plan touches.
- One focused regression test per bug. `pnpm typecheck`, `pnpm lint` and the full `pnpm test` pass.

**Out of scope:** pagination UI, new features, everything the report lists under "Considered, not recommended".

**Working rules:** commit on `main`, credited to Max; `pnpm fmt` scoped to touched packages.

## Tasks

### 1. A deactivated mailbox stops queued and approved mail (bug 1)

- `account/jobs.ts` `claimRejection`: first check `resolveSendingIdentity(storage, job.mailbox_id)`; `null` returns `"mailbox_inactive"`. `claimJob` already rejects that through `rejectUndispatched` with `failureClass: "policy"`, which also rejects the message of an approval notification and cancels its approval.
- **Test** (`due-work.test.ts`, one test for both paths): an approval notification is sent, a second message is queued, the mailbox is deactivated and the approval granted, then due work runs. Neither message reaches the provider; both jobs end `rejected` / `policy` / `mailbox_inactive`.
- **Done:** yes. The test failed before the fix (both messages sent).

### 2. Fingerprint what the caller sent (bug 2)

- `api/operations.ts`: `submissionFingerprint(payload)` over intent, `fromAddressId`, subject, text, html, and either `to`/`cc` (compose) or `replyToMessageId`/`replyMode` (reply). `submitPrepared` passes it as `SubmitOutboundInput.intentFingerprint`.
- `account/jobs.ts`: delete `outboundIntentFingerprint`; the store compares the given fingerprint. Old rows keep their old fingerprint; a retry of a pre-deploy request conflicts once (no compatibility code).
- **Test** (`api.test.ts`, "replays an identical reply once its parent is accepted"): reply with requestId X → parent accepted → same reply with X returns the same job, two jobs stored in all; changed body, parent or mode with X → 409.
- Store-level fixtures pass a fixed fingerprint; `submissions.worker.spec.ts` derives it from its options, so its changed-payload case still conflicts.
- **Done:** yes. The test failed before the fix (409).

### 3. Load the whole conversation in the console (bug 3)

- `web/pages/mail.ts` `threadRoute`: a small loop follows `nextCursor` at the store's largest page, before and (when anything was unread) after marking read.
- **Test** (`web/mail.test.ts`): a 201-message conversation shows message 201 by default, and `?open=<201st>` answers 200.
- **Done:** yes. The test failed before the fix.

### 4. CLI time and ids through Effect services (simplification 4)

- Delete `OAuthScheduler` (`auth.ts`, `runtime.ts`); use `Clock.currentTimeMillis` and `Effect.sleep`. Polling behaviour (interval, `slow_down`, expiry, lock) is unchanged.
- `commands/index.ts`: the default requestId comes from `Crypto.randomUUIDv4` (NodeServices provides it) instead of `node:crypto`.
- Tests move time with `TestClock`: `whileTimePasses` forks the login and advances the clock a second at a time; the fake HTTP client records the clock time of each request, and the poll test asserts 2 s, 4 s and 11 s.
- **Done:** yes.

### 5. Alchemy's `SendClient.send` (simplifications 5 and 5b)

- `mail/email-sender.ts`: `send` calls `client.send(toSendEmailMessage(mail))` with the runtime context captured at construction; `SendEmailError.cause` goes through the existing classifier. `ProviderSendMessage` becomes alchemy's `SendEmailMessage`.
- 5b: `OutboundMail.html` is `string | null`; `readDispatch` no longer reads `has_remote_images`; `ProviderOutboundMail` merges into `OutboundMail`.
- Tests: `email-sender.test.ts` fake client fails like alchemy (`SendEmailError`); a synchronous throw is classified.
- **Done:** yes. Checked against alchemy `SendBinding.ts` (`tryPromise` → `SendEmailError { cause }`) and effect `tryPromise` (a synchronous throw goes through `catch`).

### 6. Drop `cid:` image rewriting (simplification 6)

- `mail/html-policy.ts`: `sanitizeForStorage(html)` only. Delete `MailHtmlSanitization`, `MailHtmlAttachment`, `cidMap`, `normalizeCid`, `SAFE_IMAGE_TYPES`, `CidResolution`. A `cid:` image keeps its alt text and no `src`.
- Callers: `process-index.ts`, `operations.ts`, test fakes; the cid tests assert the image is dropped.
- **Done:** yes. The sanitizer-call recording in the fakes was only used by the removed assertion, so it went too.

### 7. Cursor DCR profile in one place (simplification 7)

- `auth/options.ts`: the normalized registration carries `application_type: "native"` for the Cursor profile.
- The patch shrinks to one line in `validateClientRedirectUri`: `cursor://anysphere.cursor-mcp/oauth/callback` passes. The before-hook already refuses that URI outside the Cursor profile, and DCR is the only registration path.
- Tests: `oauth.test.ts` Cursor registration cases pass unchanged.
- **Done:** yes. Regenerated with `pnpm patch --ignore-existing` and `pnpm patch-commit`; the lockfile hash changed and the installed file has the one-line exception. With the new patch and the old hook, the two Cursor tests failed; with the hook emitting `native`, they pass. `docs/operations.md` describes the smaller patch.

### 8. Module-local exports (item 8)

- Drop `export` from symbols used only in their own module, in modules touched above.
- **Done:** yes: `storeCall` (`operations.ts`), `mailListPage` and `threadPage` (`web/pages/mail.ts`). The stale comment in `app-runtime.ts` is in a module this plan does not touch.

## Open questions

None.

## Code review

Codex reviewed `b47d065..17359aa`: no bug or security findings. It re-ran the three repros independently (REST deactivate, reply replay before and after acceptance, a 405-message conversation in agent-browser) and checked alchemy, effect and oauth-provider source. One simplification, fixed: `threadPage` was still exported although only `threadRoute` uses it.
