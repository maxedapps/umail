# 0003: A server-rendered web console on one page system

- **Status:** Accepted (2026-09-25)
- **Date:** 2026-09-25
- **Supersedes:** in ADR 0001, decision 3, the clause "the CLI is … the only way to get operator (REST) access". REST stays CLI-only, but the operator's signed-in browser session becomes a second operator surface, for the web pages only.

## Context

The browser pages (login, consent, device, `/clients`, approvals, notices) share one narrow card layout. They are built from one stylesheet kept in a TypeScript string (`MAIL_LEDGER_STYLESHEET`) and HTML strings escaped by hand. The 2026-09-25 UI review found these problems:

- **`/clients`** reads as one long list.
- **Policy fields are typed text:** mailbox IDs and the magic words `all` and `any`.
- **Hints have no styles.**
- **Feedback is missing:**
  - the `?updated=1` and `?revoked=1` flags are never read;
  - a failed save shows a generic error page and loses the input.
- **Consent asks for mailbox IDs** at the one moment you can't look them up, and shows the raw client ID.
- **Login dead-ends** without `next`, and allows `next` only for `/clients` and `/device`.
- **There is no nav and no sign-out.**
- **Timestamps are raw ISO strings.**

The owner also wants a lean web UI to view, read and send mail. AgentMail stays agent- and CLI-first; this is not an everyday mail client. It must be clean, use modern vanilla CSS and browser features, and follow Effect and Alchemy idioms (ADR 0002).

## Decision

1. **One server-rendered page system in `apps/server/src/web/`.** It serves every browser page:
   - the rebuilt existing pages;
   - a console with Mail, Mailboxes and Clients.

   No SPA, no client framework, no build step. Pages render in the same Worker and call `operations.ts` in-process, the same way MCP does.

2. **Modern vanilla CSS in a real `.css` file.**
   - It is imported with Alchemy's `?raw` loader (Vite-compatible, so tests read it the same way) and inlined with the page nonce. The CSP keeps `style-src-attr 'none'`.
   - It uses cascade layers, `light-dark()` tokens, nesting, `:has()`, `:user-invalid`, container queries, the Popover API and cross-document view transitions.
   - _Amended during implementation:_ the stylesheet is a TS module (`web/styles.ts`, one `String.raw` template) instead of a `.css` file imported with `?raw`. `alchemy deploy` evaluates the stack in Node, and alchemy's Node loader cannot import `?raw`, so the import fails before anything deploys. The Vite config loader for the worker and browser test configs fails the same way. The rendered stylesheet and the CSP are unchanged.
3. **Auto-escaping `html` template.** An `html` tagged template escapes by default and replaces the hand-called `escapeHtmlText`.
4. **One router.** Every route, pages included, is registered on Effect's `HttpRouter` next to the `HttpApi` groups. Forms decode with `HttpServerRequest.schemaBodyUrlParams`. The manual pathname dispatch and the regex route chain are deleted.
5. **Operator session principal.**
   - Console routes turn the Better Auth session into an operator `Principal` with client id `umail-web`, labelled "AgentMail web". The unused `identity.kind` is dropped.
   - REST stays bearer-only. MCP is unchanged.
6. **JavaScript only where it earns its place.** Login and consent keep their small nonce'd scripts. Console pages get one nonce'd script that shows times in the viewer's zone. Everything else is forms, `303` redirects and CSS.
7. **Mail bodies render in a sandboxed frame.** A session-gated body route reuses the approval preview's sandbox CSP, with one change: it allows `img-src 'self'`. Inline (`cid:`) images then load through the console's attachment route, and remote images stay blocked.
   - _Amended during implementation (owner's decision, 2026-09-25):_ inline images are not shown. The body route uses the approval preview's CSP unchanged (`img-src 'none'`), and inline images are listed as attachments. Chromium sends the sandboxed frame's image requests as cross-site, so they carry no `SameSite=Lax` session cookie and the attachment route answers 303 to `/login`. The owner chose this over embedding them as `data:` URIs or giving the frame `allow-same-origin`.
8. **Opening a conversation marks it read.** "Mark unread" undoes that.

## Alternatives

| Option                                                      | Why not                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Simplest: restyle the existing pages, no console**        | Leaves the string-built pages and the hand escaping, and gives no way to read or send in a browser. The owner asked for both.                                 |
| SPA (Vite + React) served as Worker assets                  | Needs an `/api/v1` move, cookie auth plus CSRF on REST, a frontend build, and two rendering systems. That buys interactivity a non-daily client doesn't need. |
| Console calls REST from the browser as an OAuth PKCE client | Tokens in page JS, refresh handling, and CORS/CSP for JSON. In-process calls need none of that.                                                               |
| JSX (hono/jsx, preact-render-to-string)                     | Adds a dependency and TSX config. A tagged template gives the same escaping guarantee.                                                                        |
| Stylesheet as a static asset (`style-src 'self'`)           | Adds assets config and cache busting for one operator. The inline nonce'd style already works.                                                                |
| Server-side time zone via `Config`                          | Adds an env var and is wrong whenever the operator travels. The viewer's browser knows its zone.                                                              |

## Consequences

- **A second operator surface.** A stolen session cookie now reads and sends mail as well as managing clients. Better Auth's cookie flags, `cookieMutationAllowed` on every POST, and `frame-ancestors 'none'` stay the guards.
- **Console pages run one script.** They are no longer script-free, but the script is nonce'd and only formats `<time>` elements.
- **Limited mail rendering.** No images are shown in a mail body, remote or inline, and a sandboxed frame has a fixed height. Inline images are listed as attachments.
- **Viewing changes state.** A conversation's GET marks it read. It is the operator's own session, and the change is visible and reversible.
- **The page tests are rewritten**, because they assert today's markup and class names.
- **README scope changes.** "There is no … browser mailbox" is no longer true.
