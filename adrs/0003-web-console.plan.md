# Plan for 0003: A server-rendered web console on one page system

- **Status:** In progress (tasks 1–4 done)
- **ADR:** `adrs/0003-web-console.md`

## Goal

**Done when:**

- Every browser page renders from `apps/server/src/web/`, with one stylesheet file, one document renderer, the auto-escaping `html` template and one Effect `HttpRouter`. That covers login, consent, device, clients, approval, notices and the new console.
- The operator can, in a browser:
  - sign in and out;
  - read mail across all mailboxes or one;
  - open conversations and download attachments;
  - mark conversations read or unread, and delete them;
  - write new messages, reply and reply-all, and see the send status;
  - manage mailboxes and forwarding;
  - manage client access.
- Consent is rendered on the server, with the client's name and mailbox checkboxes.
- Everything in **Deletions** is gone.
- `pnpm lint` (0 warnings), `pnpm typecheck` and the full `pnpm test` pass, including the root, worker and browser suites.

**Out of scope:**

- search and an unread-only filter;
- remote images in mail bodies;
- HTML compose, drafts, attachments on outgoing mail, and forwarding a message;
- an approvals queue in the console (approval stays on the email link);
- a jobs history list;
- live updates;
- raw source and header views;
- an SPA, an `/api/v1` move, or a static CSS asset.

**Working rules:**

- One commit per task, credited to the owner.
- Run `pnpm fmt` only on the packages touched.
- No dev server and no browser automation against a stage. The owner runs the manual QA listed at the end after deploying.
- The headless Chromium specs in `pnpm test` stay allowed.

## Target shape

```
apps/server/src/web/
  html.ts          html`` template (auto-escape), Html brand, bidi text/address helpers
  styles.ts        the whole stylesheet, one String.raw template (ADR amendment: not a ?raw .css file)
  document.ts      renderDocument(view, nonce), layouts, CSP per page kind, headers, htmlResponse
  session.ts       withOperator(handler): session → operator Principal, login redirect, POST origin check
  routes.ts        one HttpRouter layer registering every non-REST route
  pages/
    login.ts  consent.ts  device.ts  clients.ts  approval.ts  notice.ts
    mail.ts   compose.ts  mailboxes.ts
```

**Page kinds and their CSP.** Every kind keeps `default-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `style-src 'nonce-…'` and `style-src-attr 'none'`.

| Kind       | Scripts             | `connect-src` | `form-action` | `frame-src` | Used by                                                                                                                                      |
| ---------- | ------------------- | ------------- | ------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`     | nonce               | `'self'`      | `'self'`      | `'none'`    | login, consent                                                                                                                               |
| `console`  | nonce (time script) | `'none'`      | `'self'`      | `'self'`    | mail, compose, mailboxes, clients                                                                                                            |
| `form`     | `'none'`            | `'none'`      | `'self'`      | `'none'`    | device                                                                                                                                       |
| `approval` | `'none'`            | `'none'`      | `'self'`      | `'self'`    | approval review                                                                                                                              |
| `static`   | `'none'`            | `'none'`      | `'none'`      | `'none'`    | notices                                                                                                                                      |
| body frame | `'none'`, `sandbox` | `'none'`      | `'none'`      | —           | approval preview: today's `APPROVAL_MESSAGE_PREVIEW_CSP`, unchanged. Console body: the same policy plus `img-src 'self'`, for inline images. |

**Routes.** None of these clash with the REST root paths (`/addresses`, `/threads`, `/messages`, `/jobs`, `/submissions`, `/sending-identities`), so REST stays where it is.

| Method   | Path                                                        | Page / action                                                      |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| GET      | `/login`, `/consent`                                        | auth pages                                                         |
| POST     | `/logout`                                                   | `auth.api.signOut`, forward its `Set-Cookie`, then 303 to `/login` |
| GET/POST | `/device`, `/device/approve`, `/device/deny`                | device flow (logic unchanged)                                      |
| GET      | `/clients`                                                  | list                                                               |
| GET/POST | `/clients/:clientId`                                        | detail, save policy                                                |
| POST     | `/clients/:clientId/revoke`                                 | revoke                                                             |
| GET      | `/mail?mailbox=&cursor=`                                    | conversation list                                                  |
| GET      | `/mail/threads/:threadId?open=`                             | conversation, one message open                                     |
| POST     | `/mail/threads/:threadId/read`, `/unread`, `/delete`        | read state, soft delete                                            |
| GET      | `/mail/messages/:messageId/body`                            | sandboxed body document                                            |
| GET      | `/mail/messages/:messageId/attachments/:attachmentId`       | download                                                           |
| GET/POST | `/mail/compose?reply=&mode=`                                | compose, reply, reply-all                                          |
| GET      | `/mail/sent/:jobId`                                         | send status                                                        |
| GET/POST | `/mailboxes`, `/mailboxes/:id`, `/mailboxes/:id/forwarding` | list and create, edit, set or remove forwarding                    |

`/mcp`, `/api/auth/*`, `/.well-known/*`, `/jwks`, `/icon.png`, `/favicon.png` and the approval routes keep their behaviour. They are only registered on the same router.

## Deletions

| What                                                                                                                                                     | Where                                                                                                                                                 | Replaced by                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Whole directory                                                                                                                                          | `apps/server/src/api/human-pages/` (`auth.ts`, `approvals.ts`, `metadata.ts`, `notices.ts`, `oauth-management.ts`, `response.ts`, `internal/page.ts`) | `web/`                                                                                                        |
| `MAIL_LEDGER_STYLESHEET`, including the duplicated dark-mode token block, the paper-ruling gradients and the `.consent-details`/`.message-details` twins | `internal/page.ts`                                                                                                                                    | `web/styles.css` with `light-dark()` tokens                                                                   |
| `escapeHtmlText` and every manual call to it                                                                                                             | pages                                                                                                                                                 | the `html` template                                                                                           |
| `createHumanPageNonce` (calls `crypto.getRandomValues` directly)                                                                                         | `internal/page.ts`                                                                                                                                    | a nonce from `Crypto` via `crypto.ts`                                                                         |
| `RenderedHumanPageTypeId`, `renderHumanPageInternal`, and the `humanPageHttpResponse`/`humanPageHttpApiResponse` split                                   | `internal/page.ts`, `response.ts`                                                                                                                     | one `renderDocument` plus `htmlResponse` and an `HttpApi` variant                                             |
| Whole file: `isOAuthRoute`, `serveOAuthRoute`, the regex route chain, `humanResponse`/`humanError`, a second `redirectResponse`                          | `apps/server/src/auth/oauth-routes.ts`                                                                                                                | `web/routes.ts`, `web/session.ts`, `web/pages/device.ts` and `clients.ts`                                     |
| The manual pathname `if` chain, `serveOAuthManagement`, and `serveBetterAuth`'s web-request plumbing, which moves into a route                           | `apps/server/src/api/app.ts` (`makeApiHttpEffect`)                                                                                                    | router registration                                                                                           |
| Address handlers written inline in `addressesGroup`                                                                                                      | `api/app.ts`                                                                                                                                          | named `Effect.fn`s in `operations.ts`, shared by REST and the console                                         |
| DOM filling of `client-id`, `scope` and `redirect-host` in `CONSENT_PAGE_SCRIPT`, and `redirectHost()`                                                   | consent script                                                                                                                                        | server-rendered values                                                                                        |
| `OAuthIdentity.kind` (never read) and the hard-coded `"AgentMail CLI"` label in `operatorOAuthPrincipal`                                                 | `packages/api-contract/src/principal-authorization.ts`, `api/mcp/route.ts`                                                                            | `PrincipalIdentity { userId, clientId, clientLabel }`, and `operatorPrincipal(userId, clientId, clientLabel)` |
| `policyFromForm` returning `null`                                                                                                                        | `auth/access.ts`                                                                                                                                      | a result naming the failing field                                                                             |
| `isAgentMailIconPath`, and the method check with its manual 405 in `serveAgentMailIcon`                                                                  | `api/brand/identity.ts`                                                                                                                               | `GET` routes for `/icon.png` and `/favicon.png`                                                               |
| Old page tests                                                                                                                                           | `apps/server/test/api/human-pages.test.ts`, `auth-pages.test.ts`                                                                                      | `apps/server/test/web/*.test.ts`                                                                              |

Delete leftovers as each task finds them. After the last task, `rg "human-pages|oauth-routes|escapeHtmlText|MAIL_LEDGER"` returns nothing.

## Stylesheet (`web/styles.ts`)

**Modern vanilla CSS only. No preprocessor, no utility framework.**

- **Layers:** `@layer reset, tokens, base, layout, components;`
- **Tokens:**
  - `color-scheme: light dark`, with every color a single `light-dark(oklch(…), oklch(…))` token.
  - Keep the burgundy accent and serif display headings.
  - Drop the ruled-paper background and the "AM" seal.
  - A fluid type and space scale with `clamp()`.
  - `forced-colors` and `prefers-reduced-motion` blocks kept.
- **Base:**
  - Logical properties throughout.
  - `text-wrap: balance` on headings and `pretty` on prose.
  - `accent-color` for controls.
  - A visible `:focus-visible` ring.
  - Controls at least 44px (`2.75rem`) tall.
  - `:user-invalid` styling for fields.
- **Layouts:**
  - `.focus`: a centred narrow column (login, consent, device, approval, notices).
  - `.console`: a header with nav (Mail, Mailboxes, Clients) and a sign-out button, then a sidebar plus main grid that collapses under a container query.
- **Components** (only ones used at least twice): `.button` (primary, secondary, danger), `.field` (label, hint, error), `.choice` (radio or checkbox card), `.badge`, `.flash`, `.list` rows, `.empty`, `.meta` (definition list), `.frame` (body iframe).
- **Progressive enhancement:**
  - `@view-transition { navigation: auto; }` for page transitions.
  - `field-sizing: content` on the body textarea.
  - The Popover API (`popovertarget`) for revoke and delete confirmations, so no JavaScript is needed.
- **Conditional fields** use `:has()`, for example `.field:has(~ …)` or `form:has([value=requireApproval]:checked) .preapproved`.

## Tasks

### 1. Web foundation: template, stylesheet, document, existing pages ported

**Start in:** a new `apps/server/src/web/`.

- **`html.ts`**
  - `html` tagged template returning a branded `Html`. Interpolated strings are escaped. `Html` values and arrays of `Html` pass through.
  - No `raw()` escape hatch, except one internal use for the stylesheet and script bodies inside `document.ts`.
  - Move `projectApprovalDecisionMetadata` and the bidi `<bdi>` helpers here, as `bidiText` and `bidiAddress`.
- **`styles.ts`**
  - Write the stylesheet described above.
  - _Changed during implementation:_ planned as `styles.css` imported with `?raw` plus a `raw.d.ts`. `alchemy deploy` evaluates the stack in Node, whose alchemy loader cannot import `?raw` (`ERR_UNKNOWN_FILE_EXTENSION`), and the worker and browser test configs fail the same way. See the ADR amendment.
  - _Also found:_ Oxc lowers a tagged template that contains a closing `script` tag into a `@oxc-project/runtime` helper, which the Node loader cannot resolve. `document.ts` builds the script element with a plain template. Check with `node --import ./node_modules/alchemy/bin/register-oxc.js -e 'import("./alchemy.run.ts")'`.
- **`document.ts`**
  - `renderDocument(view, nonce)`, where `view` holds kind, layout, title, heading, lede, main, and an optional flash and script.
  - `pageHeaders(kind, nonce)`, following the CSP table.
  - `htmlResponse(status, …)`, which returns an Effect `HttpServerResponse`.
  - `approvalHttpApiBody(…)` for the `HttpApi` approval errors and pages.
  - `pageNonce`, an Effect over `Crypto.randomBytes` in hex.
- **Port the pages**
  - Port approval, notice, login and device onto the new renderer.
  - **Copy:** "Sign in to AgentMail", "Email" and "Password". No "mail ledger", no "Better Auth", no "provider call", no "mail worker".
  - **Approval page:**
    - a summary line at the top ("Claude Code wants to send "Re: …" to Anna Example and 1 more");
    - `<time datetime>` values shown as `24 Sep 2026, 08:00 UTC`;
    - "expires in 23 h" while the approval is pending;
    - no Expires row after a decision.
  - The approval page stays script-free.
- **Move the clients page:** move `renderClientsPage` to `web/pages/clients.ts` with only the template swapped. Task 5 rebuilds it.
- **Delete:** all of `api/human-pages/`, then repoint the imports in `api/app.ts` and `auth/oauth-routes.ts`.

**Verify:**

- **Stack evaluation:** `alchemy.run.ts` imports under alchemy's Node loader (the command above).
- **`test/web/html.test.ts`:**
  - Interpolated `<script>` and quotes are escaped.
  - Nested `Html` is not double-escaped.
  - Bidi controls are removed and line separators become `⏎`. These cases move over from `human-pages.test.ts`.
- **`test/web/document.test.ts`:**
  - Each page kind emits exactly its CSP row.
  - The nonce is fresh per render and present on `<style>`, and on `<script>` only when the kind allows scripts.
  - `x-frame-options: DENY`, `no-store` and `noindex` are set.
- **`approval-flow.test.ts`** stays green. Update the text assertions for the new copy.
- **Browser spec** (`human-pages.browser.spec.ts` and its fixture and model files, renamed `web-pages.*`). Update the `include` in `apps/server/vitest.browser.config.ts` and the `exclude` in `apps/server/tsconfig.json` to match. The spec checks:
  - no CSP violations on login, consent and every approval state;
  - focus ring visible, controls at least 44px;
  - no horizontal scroll at 390px;
  - dark scheme tokens applied.

**Done:** yes. The horizontal-scroll check stays at 320px, which is stricter than 390px.

### 2. One router, sessions, sign-out, login return paths

**Start in:** `apps/server/src/api/app.ts` (`makeRestHttpEffect`/`makeApiHttpEffect`) and a new `web/routes.ts` and `web/session.ts`.

- **One router**
  - `makeApiHttpEffect` becomes `HttpRouter.toHttpEffect(Layer.mergeAll(HttpApiBuilder.layer(UmailApi), HttpApiBuilder.layer(PublicApprovalApi), webRoutes(deps)))`, with the existing providers.
  - `webRoutes` registers these with `HttpRouter.add`, keeping their current handlers: `/icon.png`, `/favicon.png`, `/mcp`, `/jwks`, `/api/auth/*`, `/.well-known/*`, `/login`, `/consent` and the device routes.
  - The router is still built per request (ADR 0002 amendment 3).
  - Wildcard paths (`/api/auth/*`, `/.well-known/*`) must match exactly as today's prefix checks did. `oauth.test.ts` and `mcp.test.ts` prove it.
- **`session.ts`**
  - `withOperator(handler)` reads `auth.api.getSession`, then:
    - no session: 303 to `/login?next=<path+search>`;
    - a user that isn't the operator: a 403 notice;
    - a POST that fails `cookieMutationAllowed`: 403;
    - otherwise it calls the handler with the operator `Principal` from task 3.
  - Form bodies decode with `HttpServerRequest.schemaBodyUrlParams`, path params with `HttpRouter.schemaParams`, and queries with `HttpServerRequest.schemaSearchParams`.
- **`POST /logout`** calls `auth.api.signOut({ headers, asResponse: true })`, copies `Set-Cookie`, then 303s to `/login`. The console header gets a sign-out form.
- **Login script**
  - `sameOriginReturnPath` allows `/device`, `/clients`, `/mail` and `/mailboxes`, plus their sub-paths. It keeps every existing hostile-input check.
  - With no valid `next`, it goes to `/mail` instead of the "Signed in…" message.
- **Delete:**
  - the manual `if` chain in `makeApiHttpEffect`;
  - `serveOAuthManagement`;
  - `isOAuthRoute` and `serveOAuthRoute`, along with the rest of `auth/oauth-routes.ts` once device moves to `web/pages/device.ts`.

**Verify:**

- **`oauth.test.ts`, `mcp.test.ts`, `static-client.test.ts`, `auth-boundaries.test.ts` and `api.test.ts` pass unchanged.** They prove that the router move changes no behaviour.
- **New `test/web/session.test.ts`:**
  - a console GET without a cookie redirects to `/login?next=`;
  - a cross-site POST gets 403;
  - `POST /logout` clears the session, so the next `/mail` redirects.
- **Browser spec:** login with `next=/mail/threads/x` lands there; with no `next` it lands on `/mail`; hostile `next` values are still ignored (existing cases, with the allowlist extended).

**Done:** yes. One planned-unchanged assertion changed: `POST /icon.png` now gets the router's 404 instead of the hand-written 405, because the icon routes are `GET` routes (`mcp.test.ts`). Routes are registered as one `HttpRouter.add` layer each: `HttpRouter.addAll` widened the handler's error and requirement types to `any`.

### 3. Operator principal for the browser session

**Start in:** `packages/api-contract/src/principal-authorization.ts`.

- Replace `OAuthIdentity`/`PrincipalIdentity` with `PrincipalIdentity = { userId, clientId, clientLabel }`, dropping the unused `kind`.
- Replace `operatorOAuthPrincipal(userId, clientId)` with `operatorPrincipal(userId, clientId, clientLabel)`.
  - `verify.ts` passes `UMAIL_CLI_CLIENT_ID` and "AgentMail CLI".
  - `session.ts` passes a new `UMAIL_WEB_CLIENT_ID = "umail-web"` and "AgentMail web".
- Update `api/mcp/route.ts` (drop `kind: "oauth"`).

**Verify:**

- `principal-authorization.test.ts` and `principal-policy.test.ts` pass.
- New case in `test/web/session.test.ts`: a message sent from the console stores the requester label "AgentMail web" and client id `umail-web`, read back through `getJob` or the stored job.

**Done:** yes. `verify.ts` keeps passing the token's own client id (only the CLI can hold a REST token) with the label "AgentMail CLI". The console-requester case needs the compose route, so it lands in task 7's `compose.test.ts`.

### 4. Mailbox operations shared by REST and the console

**Start in:** `apps/server/src/api/app.ts` (`addressesGroup`).

- Move the handler bodies into `operations.ts` as `Effect.fn`s: `createAddress`, `listAddresses`, `patchAddress`, `setAddressForwarding` (`destinations.ensure` plus the store) and `removeAddressForwarding`.
- The REST handlers become one-line calls.

**Verify:** `api.test.ts` and `destinations.test.ts` pass unchanged.

**Done:** yes. `getAddress` moved too, since the console's mailbox page reads one address.

### 5. Clients list and detail, server-rendered consent

**Start in:** `web/pages/clients.ts`, `web/pages/consent.ts`, `auth/access.ts`.

**`auth/access.ts`**

- `policyFromForm` returns `{ kind: "ok", policy } | { kind: "invalid", field, message }`, where the field is `mailboxes`, `recipients` or `preapproved`.
- The consent before-hook in `options.ts` uses `message`.
- Add `access.clientName(clientId)`: one `oauthClient` lookup.

**`/clients`**

- One row per grant: name (falling back to the client ID in a monospaced style), a badge (Operator CLI / Agent / No access), and a one-line summary such as "All mailboxes · reads · sends with approval · any recipient".
- Each row links to its detail page.
- A flash message shows when the URL carries `?saved` or `?revoked`.

**`/clients/:clientId`**

- **Mailboxes:** "All mailboxes" or "Only these" radio cards. The "Only these" choice reveals checkboxes of real addresses (from `listAddresses`) through `:has()`.
- **Reading:** a checkbox.
- **Sending:** radio cards for Never / With my approval / Without approval. "Skip approval for" (preapproved addresses) shows only under "With my approval".
- **Recipients:** "Anyone" or "Only these" (comma-separated).
- **Save** runs the route, which turns the checked mailboxes into the existing `mailboxes` string (`all` or comma-joined ids), then calls `policyFromForm`:
  - on `invalid`, a 400 re-render with the error on that field and every value kept;
  - on `ok`, 303 to `/clients/:clientId?saved`.
- **Revoke** sits in a danger section. A `popovertarget` button opens a popover with the real revoke form.
- **CLI row:** the detail page shows only the revoke section.
- **No-policy consents** (the hook's rare failure path) get a "No access" badge, and the form starts empty with a "Grant access" button.

**Consent** becomes a session route (`withOperator`) that renders:

- the client name from `access.clientName(query.client_id)` and the redirect host from `query.redirect_uri`;
- scope in words ("Use your mailboxes · stay signed in");
- the same mailbox radio and checkbox control, plus sending radio cards.

The consent script shrinks to building the `mailboxes` string from the checked boxes and posting as today. The after-hook is unchanged.

**Delete:** the interim clients renderer from task 1, and the consent script's DOM-filling code.

**Verify:**

- **`test/web/clients.test.ts`:**
  - The list shows the name, badge and summary.
  - Saving checked mailboxes stores the `["id1","id2"]` scope.
  - An invalid preapproved address re-renders with 400, the field error, and the typed values kept.
  - `?saved` shows the flash.
  - Revoke deletes the consent (the existing `access` behaviour).
- **`oauth.test.ts`:** consent with checked mailboxes stores that policy; an invalid entry shows the hook's message.
- **Browser spec:**
  - The consent page has no CSP violations.
  - The preapproved field is hidden until "With my approval" is chosen.
  - The revoke popover opens by keyboard with no JavaScript.

**Done:** no.

### 6. Mail: list, conversation, body frame, attachments, read state, delete

**Start in:** `web/pages/mail.ts`.

**`/mail`**

- The sidebar lists "All mailboxes" plus every address (`listAddresses`) as links.
- Rows come from `listThreads(deps, scopedPrincipal, 25, cursor)`. `scopedPrincipal` is the operator principal with `policy.mailboxIds = [mailbox]` when filtered, so there's no store change.
- Each row: sender, subject, involved mailbox, `<time>`, message count, and bold when `unreadCount > 0`.
- An "Older" link carries the cursor.

**`/mail/threads/:threadId`**

- `getThread` supplies the message headers (the first page, oldest first).
- One message is open: `?open=<id>`, otherwise the newest. The rest are collapsed rows linking to `?open=`.
- **The open message:**
  - `getMessage` returns the metadata (from, to, cc, date, mailbox);
  - the text-only body is rendered in `<pre>`-wrapped prose;
  - an HTML body is rendered as `<iframe sandbox src="/mail/messages/:id/body" loading="lazy">` with a tall `.frame` (`min(80dvh, 60rem)`), plus a plain-text alternative in `<details>`;
  - a "Remote images are blocked" note shows when `hasRemoteImages` is set;
  - the attachment list links to downloads.
- **Opening marks read:** the GET calls `setThreadReadState(…, true)` when `unreadCount > 0`.
- **Actions:** Reply, Reply all, Mark unread (POST, then 303 to `/mail`), and Delete conversation (a popover confirm, then POST, then 303 to `/mail` with a flash).

**Other routes**

- **Body route:** `getMessage`, then the body document with the console body CSP. It reuses the approval preview's HTML wrapper, moved to `document.ts`. A message without HTML returns 404.
  - **Inline images:** the sanitizer stores `cid:` images as `src="/messages/<id>/attachments/<aid>"` (`mail/html-policy.ts`). The route rewrites exactly that prefix for this message id to `/mail/messages/<id>/attachments/`, so the frame loads them through the session-gated attachment route.
- **Attachment route:** `readAttachment` plus `attachmentResponseHeaders`.

**Time script:** the console-kind script (under 20 lines, nonce'd) rewrites each `<time datetime>` with `Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })`. The server text stays as the UTC fallback.

**Verify:**

- **`test/web/mail.test.ts`**, seeded through `world.ts`'s `seedMailbox`:
  - The list shows both mailboxes' threads, and `?mailbox=A` only A's.
  - Unread rows are marked.
  - The cursor pages.
  - The thread page opens the newest message by default and `?open` picks another.
  - The body route sends `sandbox` and `img-src 'self'`, and rewrites a seeded `cid:` image to the console attachment path. Without a session it answers like every console route: a 303 to `/login`.
  - Opening an unread thread marks it read. "Mark unread" restores the unread state.
  - The attachment download has `content-disposition`.
  - Read and unread flip `unreadCount`.
  - Delete hides the thread.
- **Browser spec** (new `mail-thread` fixture):
  - no CSP violations;
  - hostile subject and sender stay inert;
  - `<time>` is localized;
  - no horizontal scroll at 390px.

**Done:** no.

### 7. Compose, reply, send status

**Start in:** `web/pages/compose.ts`, `api/operations.ts`.

**`GET /mail/compose`**

- Fields: From (a `<select>` of `listSendingIdentities`), To, Cc (comma-separated addresses), Subject and Body (textarea, `field-sizing: content`).
- A hidden `requestId` UUID from `Crypto` makes a double submit return the same job.

**Replies (`?reply=<messageId>&mode=reply|reply-all`)**

- From is fixed to the parent's mailbox. Subject is prefilled "Re: …". The derived To and Cc are shown read-only.
- To show them, export `previewReplyRecipients(deps, principal, messageId, mode)` from `operations.ts`. It is the existing `readReplyParent` plus `replyRecipients`, with no new logic.

**`POST`**

- Decode with a `Schema.Struct` and parse the addresses with `parseMailAddressList`, then call `submitMessage(deps, principal, payload)` with the compose or reply intent.
- **On invalid input:** a 400 re-render with field errors and the values kept.
- **On success:** 303 to `/mail/sent/:jobId`.

**`/mail/sent/:jobId`**

- `getJob`: the state as a badge (Queued / Sending / Accepted by Cloudflare / Not sent + reason / Outcome unknown).
- A link to the conversation (`job.threadId`) and a "Refresh" link.

**Verify:**

- **`test/web/compose.test.ts`:**
  - Compose submits a job with the `umail-web` requester.
  - Reply-all derives the same recipients as the MCP reply path (compare with `mcp.test.ts`'s expectation).
  - A resubmit with the same `requestId` returns the same job.
  - An invalid To re-renders with the error.
  - The status page shows the job state.
- **Browser spec:** the compose page has no CSP violations, and the textarea grows.

**Done:** no.

### 8. Mailboxes and forwarding

**Start in:** `web/pages/mailboxes.ts`.

- **`/mailboxes`:** a list of address, display name, badge (Active / Inactive) and forwarding target, plus a "New mailbox" form (local part and display name). The domain is shown as a fixed suffix.
- **`/mailboxes/:id`:**
  - edit the display name and the active toggle (`patchAddress`);
  - a forwarding form calling `setAddressForwarding` and showing "Verified" or "Waiting for verification — Cloudflare emailed <address>";
  - a "Stop forwarding" POST (`removeAddressForwarding`).
- All handlers use the task 4 operations. They 303 with a flash, or re-render with field errors.

**Verify:** `test/web/mailboxes.test.ts`:

- create, then list;
- deactivate removes the address from the compose From list;
- setting forwarding with the fake destinations client reports its verified state;
- removing forwarding clears `forwardTo`;
- a duplicate local part re-renders with an error.

**Done:** no.

### 9. Docs and final sweep

- **README:**
  - Replace "There is no … browser mailbox" with a short "Web console" paragraph: what it does and doesn't do, from the feature list below.
  - Point first-time users to `/mail` after `/login`.
- **`docs/operations.md`:** add the operator session as a second operator surface next to the CLI line (ADR 0003).
- **Final sweep:**
  - Run the `rg` check from **Deletions**.
  - Confirm there are no unused exports (`pnpm lint`).
  - Confirm there are no inline `style=` attributes: `rg 'style="' apps/server/src/web` returns nothing.

**Verify:** `pnpm fmt` on the touched packages, `pnpm lint`, `pnpm typecheck` and `pnpm test`.

**Done:** no.

## Security invariants (checked in tasks 1, 5, 6 and 7)

- `style-src-attr 'none'` everywhere except the body frame, whose sandbox CSP is unchanged.
- Scripts run only with the page nonce. The approval, static and body-frame kinds have `script-src 'none'`.
- `frame-ancestors 'none'` and `X-Frame-Options: DENY` on every page. The body frame allows only `'self'` ancestors.
- Metadata still passes through the bidi and control-character projection (`bidiText`/`bidiAddress`).
- Approval links work without signing in.
- Every console POST passes `cookieMutationAllowed` and needs the operator session.
- Controls are at least 44px, with a visible focus ring.

## Owner's manual QA after deploy

- Sign in, then land on `/mail`. Sign out.
- Open a real HTML newsletter and a plain-text mail. Download an attachment.
- Reply to yourself, then check the status page and the conversation.
- Create a mailbox, and set and verify forwarding.
- Connect an MCP client: check the consent screen, then narrow it on `/clients`, then revoke it.
- Check light, dark and phone widths.

## Open questions

None. Both are resolved, 2026-09-25: opening a conversation marks it read, and inline images are shown.
