# Plan for 0004: A minimal visual design for every browser page

- **Status:** In progress
- **ADR:** `adrs/0004-minimal-web-ui.md`
- **Visual spec:** the approved mockup, version 2: https://claude.ai/artifact/XMd6W4PyEwaqC3VJBUXSH8. A local copy is at `adrs/0004-minimal-web-ui.mockup.html`, and task 8 deletes it.

## Goal

**Done when:**

- Every browser page matches the mockup's design, in light and dark mode and down to 320px. That covers:
  - the console: mail list, conversation, compose, send status, mailboxes, mailbox detail, clients and client detail;
  - login, consent, device, approval and the notices.
- `apps/server/src/web/styles.ts` holds only the new stylesheet. Every class it defines is used by some page, and every class a page uses is defined in it.
- Everything in **Deletions** is gone and the checks in task 8 come back empty.
- `pnpm lint` (0 warnings), `pnpm typecheck` and the full `pnpm test` pass, including the browser suite with its expectations unchanged.

**Out of scope:**

- new features, routes or data (for example no thread previews, no per-mailbox unread counts, no theme toggle);
- copy rewrites beyond the few listed below;
- web fonts and any CSP change;
- the text-only approval notification email.

**Working rules:**

- One commit per task, credited to the owner.
- Run `pnpm fmt` only on `apps/server` (memory: `oxfmt .` rewrites unrelated files).
- No dev server and no browser automation against a stage. The owner runs the manual QA at the end. The headless Chromium specs in `pnpm test` stay.
- Every task's check is the **full** `pnpm test`, because the 320px overflow and 44px checks in the browser suite are what break between tasks.
- **No stopgap CSS for old classes.** If task 2's browser run fails on a page whose markup is not ported yet, pull that page's port forward into task 2. Never add rules for `.list`, `.row`, `.panel` or any other old class to get green.

## Porting the mockup

The mockup's CSS is the starting point for `styles.ts`. Port its tokens and component rules, and keep today's `@layer reset, tokens, base, layout, components;` order.

**Don't port.** These exist only to run the mockup as an artifact:

- the `.intro`, `.controls`, `.seg`, `.caption`, `.window`, `.urlbar`, `.viewport` and `.screen` scaffolding, and its script;
- `--canvas` and `--viewport-h`: the sidebar uses `100dvh`;
- the theme toggle and its `color-scheme` switching: production keeps `:root { color-scheme: light dark; }`;
- the SVG sprite, whose inline `style=` production's CSP blocks: icons are inline per use (task 1);
- `scroll(nearest)`, which becomes `scroll(root)`;
- `@container viewport`: see **Responsive**;
- the mockup's own class names where the class vocabulary below chooses others (`.btn` becomes `.button`, `.option` becomes `.choice`, `.sr` becomes `.sr-only`, `.crow` becomes `.compose-row`, `.i` becomes `.icon`).

**Pitfalls found while building the mockup:**

- **No inline padding on a subgrid row.** The row's padding shifts its first and last items out of their tracks; that put the unread dot over the sender's name. The mail list gets zero-width edge tracks plus a column gap, and a negative inline margin so row text lines up with the heading.
- **Reduced motion must not remove the toast.** The current blanket rule sets `animation-duration: 0.01ms`, which would hide the toast at once. Replace it: under `prefers-reduced-motion: reduce`, the toast keyframes animate opacity only, popovers skip the scale, and `@view-transition` stays off. Fades stay.
- **A faded toast still covers the page.** Give `.toast` `pointer-events: none`.
- **Keep the tokens as `light-dark()` pairs.** The mockup already writes them this way. Keep the `forced-colors` block, mapped to the new tokens.

**Responsive:**

- `main` is the size container (`container: content / inline-size`) in both layouts.
- The sidebar turns into a top bar under `@media (width < 52rem)`.
- Components respond to `@container content`:
  - the mail list goes to two lines under 40rem;
  - toolbar button labels are visually hidden under 40rem;
  - `.meta` goes to one column under 30rem.
- `.settings` is its own container (`container: settings / inline-size`). Its sections stack under 40rem, so the consent card stacks them and the client page shows two columns.

## Invariants the browser spec and tests rely on

These must hold after every task.

- **One `h1` per page, and it is the page heading:** the thread subject, the consent question, "Sign in to AgentMail". The brand is never a heading. Popovers use `h2`.
- **Approval metadata:**
  - The approval page has exactly one `.meta`, with today's rows in today's order: Requested by, From, Reply-To (when it differs), To, Cc, Subject, Context, Requested, Expires.
  - The spec counts exactly 4 `bdi[dir="ltr"]` and at least 5 `bdi[dir="auto"]` inside it, and the hostile subject must be inside it.
  - The dl may move into the summary card. Rows may not be added or dropped.
- **Focus pages add nothing interactive to the layout:**
  - pending approval has exactly 1 form and 2 buttons;
  - decided approvals and notices have no form and no button;
  - `<details>` is fine.
- **Order in the page (DOM order), never flipped with CSS `order`:**
  - Approve & send, then Deny request. Note that this is the reverse of the mockup.
  - Allow access, then Deny.
  - Email, then Password.
- **The approval decision section sits after the body section** (`sectionsSeparated`) and is not sticky (owner's decision).
- **Selectors that stay:** `#login-submit`, `#status`, `#preapproved`, `input[name="sendMode"]`, `#revoke-dialog`, `#text`, `#message-body`, `#decision`, and the iframe titles "Message body" and "HTML email preview".
- **The mailbox nav link** keeps `aria-current="page">` immediately followed by `<span class="mono">address</span>` (`mail.test.ts`). Its `.mono` is set in the sans font inside `.subnav`.
- **Security (from ADR 0003):**
  - no `style=` attributes;
  - scripts only on `auth` and `console` pages;
  - mail metadata always goes through `bidiText` or `bidiAddress`, avatar initials included;
  - controls on focus pages are at least 44px, with a visible focus ring everywhere.

## Target shape

```
apps/server/src/web/
  html.ts        + initials(), shortTimeHtml(), contactListHtml() (the three contact-list copies merged)
  icons.ts       NEW: icon(name) and logo, inline SVG
  styles.ts      rewritten from the mockup
  document.ts    new console and focus layouts, toast and inline flash, time script with the short format
  pages/*.ts     markup rewritten to the class vocabulary below; routes and logic unchanged
```

`api/app.ts`, `routes.ts`, `session.ts` and every route handler keep their behaviour. Only the markup that pages return changes. The one exception is the PageView fields in task 2.

### `PageView` (document.ts)

```ts
export type PageView = {
  readonly kind: PageKind;
  readonly title: string;
  readonly heading: string;
  readonly lede?: Html | string | undefined;
  readonly main: Html;
  readonly flash?: Flash | undefined;
  readonly script?: string | undefined; // auth pages only, as today
  readonly section?: ConsoleSection | undefined; // console only
  readonly toolbar?: Html | undefined; // console only: back link or breadcrumbs, then actions
  readonly mailboxes?: MailboxNav | undefined; // mail pages only
};

// The mailboxes nested under Mail, and the list being read: "all", a mailbox id, or null.
export type MailboxNav = {
  readonly addresses: ReadonlyArray<Address>;
  readonly current: string | null;
};
```

`aside` is deleted.

### Console layout

```html
<body class="console">
  <aside class="sidebar">
    <a class="brand" href="/mail">{logo}AgentMail</a>
    <a class="compose" href="/mail/compose">{icon pen}Write</a>
    <nav class="nav" aria-label="Console">
      <a href="/mail" aria-current="true|false">{icon inbox}Mail</a>
      <ul class="subnav">…only when view.mailboxes is set…</ul>
      <a href="/mailboxes" aria-current="page|false">{icon at}Mailboxes</a>
      <a href="/clients" aria-current="page|false">{icon key}Clients</a>
    </nav>
    <form class="sidebar-foot" method="post" action="/logout">
      <span>Operator</span>
      <button class="button quiet icon-only" type="submit">{icon logout}<span class="sr-only">Sign out</span></button>
    </form>
  </aside>
  <main>
    <div class="toolbar">{view.toolbar}</div>           only when set; sticky
    <div class="content">
      <div class="page-head"><h1>…</h1><p class="lede">…</p></div>
      {error flash inline}
      {view.main}
    </div>
    <p class="toast" role="status">{icon check}{message}</p>   success flash only
  </main>
  {time script}
</body>
```

**`aria-current` in the nav:**

- On mail pages, Mail gets `"true"` (stronger text), and the subnav link for `mailboxes.current` gets `"page"` (the soft fill).
- On the Mailboxes and Clients pages, their own link gets `"page"`.
- `.sidebar` gets `view-transition-name: sidebar`, so it stays still while the content cross-fades.

**The toolbar:**

- It is one flex row. Its first child takes `margin-inline-end: auto`, so the actions sit on the right.
- It has no rule at rest. A hairline fades in through `animation-timeline: scroll(root)` once the page scrolls.

### Focus layout

- **`auth`, `form` and `static` kinds:**
  - `<body class="focus"><main><div class="card"><header>{logo}<h1/>{lede}</header>{flash}{main}</div></main></body>`.
  - The card is 24rem wide, or 36rem with `.card:has(.meta)` (consent, device).
- **`approval` kind:** `<body class="focus"><header class="focus-bar">{logo}AgentMail <small>Send approval</small></header><main class="column">{page-head}{main}</main></body>`.
- **Control height:** `.focus :is(button, .button, input:not([type="checkbox"], [type="radio"]), select)` gets `min-block-size: 2.75rem`, so the focus pages need no size modifier class.

### Class vocabulary

This is the complete list. The stylesheet defines exactly these, and task 8 checks it both ways.

| Group      | Classes                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Layout     | `console`, `sidebar`, `brand`, `logo`, `compose`, `nav`, `subnav`, `sidebar-foot`, `toolbar`, `content`, `page-head`, `lede`, `focus`, `focus-bar`, `card`, `column`                                                                                                                                 |
| Basics     | `icon`, `sr-only`, `mono`, `muted`, `stack`, `actions`, `label` (a toolbar button's text, hidden when narrow)                                                                                                                                                                                     |
| Controls   | `button` with `secondary` (soft fill), `quiet`, `danger`, `solid`, `icon-only`; `field`, `hint`, `error`, `suffixed`, `choices`, `choice`, `revealed`, `checklist`, `switch-row`, `switch`                                                                                                        |
| Feedback   | `badge` with `accent`, `success`, `warning`, `danger`; `chip`, `note` with `warning`, `flash`, `toast`, `status`, `empty`                                                                                                                                                                        |
| Lists      | `threads`, `thread`, `unread`, `dot`, `who`, `what`, `pager`, `rows`, `row`, `crumbs`                                                                                                                                                                                                            |
| Mail       | `messages`, `message-row`, `message`, `message-head`, `avatar`, `more` (a `details` disclosure), `meta`, `frame`, `prose`, `files`, `composer`, `compose-row`, `composer-foot`                                                                                                                     |
| Settings   | `settings`, `setting`, `danger-zone`                                                                                                                                                                                                                                                             |
| Approval   | `summary`, `decision`, `section-label`, `code` (device)                                                                                                                                                                                                                                          |

Type selectors also get styles: `[popover]` and `::backdrop`, `fieldset`, `details > summary`, `input`, `select` and `textarea`, and `:focus-visible`.

## Deletions

| What                                                                                                                                                                                                                                                            | Where                                            | Task | Replaced by                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---- | ------------------------------------------------------------------- |
| The whole current stylesheet body, including:<br>• the tokens `--paper`, `--surface`, `--sunken`, `--ink`, `--muted`, `--rule`, `--rule-strong`, `--accent-hover`, `--accent-ink`, `--accent-soft` and the `*-soft` tones<br>• `--font-serif`<br>• the fluid `--step-*` and `--space-*` scales<br>• the serif `h1–h3` rule | `web/styles.ts`                                  | 2    | the ported mockup stylesheet                                         |
| Classes: `.wordmark`, `.console > header` and its nav, `.console-body`, `.console-grid`, `.section`, `.split` (already unused), `.list`, today's `.row` with `.primary`/`.secondary`/`.aside` children, `.panel`, `.nav-list`, `.checks`, the left-bordered `.flash`/`.note`, the dashed `.empty` | `web/styles.ts`                                  | 2    | the class vocabulary                                                |
| The blanket reduced-motion rule (`* { animation-duration: 0.01ms !important … }`)                                                                                                                                                                                | `web/styles.ts`                                  | 2    | targeted reduced-motion rules (see **Porting the mockup**)          |
| `PageView.aside` and the `<aside>` / `console-body` / `console-grid` wrappers, the console `<header>` with its nav, and the focus `<header><span class="wordmark">`. `flashHtml` is rewritten, not kept beside a new one | `web/document.ts`                                | 2    | the sidebar, `toolbar`, `mailboxes`, a new `toastHtml` and the rewritten `flashHtml` |
| `mailboxNav` (the `aside` builder), and its `<nav class="stack">` with the full-width Write button                                                                                                                                                              | `web/pages/mail.ts`                              | 2    | `view.mailboxes`, rendered by `document.ts`                         |
| `composeAside`                                                                                                                                                                                                                                                  | `web/pages/compose.ts`                           | 2    | a `mailboxes: { addresses, current: null }` value                   |
| `contactList` (mail.ts), `contactList` (approval.ts), `contactsHtml` (compose.ts)                                                                                                                                                                               | `web/pages/`                                     | 1    | `contactListHtml` in `html.ts`                                      |
| `threadRow`, `collapsedMessageHtml`, `openMessageHtml` markup (rewritten, not kept beside the new)                                                                                                                                                             | `web/pages/mail.ts`                              | 3    | new markup of the same functions                                    |
| The `<section class="section">` "Message details" block and the separate `summaryHtml` panel                                                                                                                                                                    | `web/pages/approval.ts`                          | 7    | one summary card holding the `.meta`                                |
| The reply `<dl class="meta">` on compose                                                                                                                                                                                                                        | `web/pages/compose.ts`                           | 4    | read-only `.compose-row`s                                           |
| The mockup copy                                                                                                                                                                                                                                                 | `adrs/0004-minimal-web-ui.mockup.html`           | 8    | the artifact URL in the ADR                                         |

## Tasks

### 1. Icons, avatar initials, short times, one contact list

**Start in:** a new `web/icons.ts`, then `web/html.ts` and `web/document.ts` (`TIME_SCRIPT`).

- **`icons.ts`**
  - `icon(name: IconName): Html` returns `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">…</svg>`.
  - The paths are copied from the mockup's `<symbol>`s as constant `html` literals. Stroke and fill come from the `.icon` CSS, not attributes.
  - Names: `inbox`, `pen`, `at`, `key`, `logout`, `reply`, `reply-all`, `mail`, `trash`, `clip`, `send`, `left`, `right`, `clock`, `eye-off`, `alert`, `check`. Every one is used by a later task; drop any that end up unused.
  - `logo: Html` is the mockup's disc-and-envelope SVG with the `.logo` class, and `aria-hidden="true"`.
- **`html.ts`**
  - **`initials(name: string): string`:** the first letter or digit of up to two words of `displayText(name)`, upper-cased, or `"?"` when there are none. It is rendered through `html`, so it is escaped.
  - **`shortTimeHtml(iso)`:** `<time datetime="…" data-short>` with the same UTC fallback text as `timeHtml`.
  - **`contactListHtml(contacts)`:** a `<ul>` of `contactHtml` items, or `<span class="muted">Nobody</span>` when the list is empty. It replaces the three copies (see **Deletions**) and their call sites switch now.
- **`TIME_SCRIPT`**
  - Plain `<time>` keeps the `medium`/`short` format.
  - `[data-short]` shows the time only when it is today, month and day when it is this year, and `dateStyle: "medium"` otherwise.
  - `title` keeps the UTC text. The script stays under 25 lines.

**Verify:** `test/web/html.test.ts` gets these cases:

- `initials`: "Anna Berg" gives "AB"; "anna@example.com" gives "A"; a name made of bidi controls and punctuation gives "?"; `<b>` markup comes out escaped.
- `shortTimeHtml` carries `data-short` and the UTC fallback.

Then run the full `pnpm test`.

**Done:** yes. `icons.ts` holds the 17 icons and the logo (the logo's parts are styled through `.logo circle|rect|path`, so it needs no extra classes). The three contact lists are now `contactListHtml`.

### 2. Stylesheet and the two layouts

**Start in:** `web/styles.ts` and `web/document.ts`.

- **`styles.ts`:** replace the whole template with the ported stylesheet, following **Porting the mockup** and **Class vocabulary**.
  - Components that aren't in the mockup follow the same rules:
    - **`.rows`/`.row`** (mailbox and client lists): rounded rows that fill on hover, with no dividers. A row is a first line (name plus badge) and a muted second line.
    - **`.suffixed`:** an input joined to a soft-filled domain suffix.
    - **`.flash`:** a danger-tinted block with an alert icon and no border.
    - **`.empty`:** centred muted text with padding and no border.
    - **`.code`:** large, letter-spaced monospace text.
    - **`.section-label`:** small uppercase muted text.
    - **`.prose`:** the text body in the sans font, on `--surface`, with `max-block-size: 40rem` and scrolling.
  - Keep `@view-transition { navigation: auto; }` and turn it off under reduced motion.
- **`document.ts`:**
  - Implement **PageView**, **Console layout** and **Focus layout** above.
  - `flashHtml` renders an error as `<p class="flash" role="alert">{icon alert}…</p>` in the content. `toastHtml` renders a success as the toast.
- **Call sites:**
  - `mail.ts` and `compose.ts` pass `mailboxes` instead of `aside`.
  - Delete `mailboxNav` and `composeAside` (see **Deletions**).
  - The Write link moves into the sidebar, so mail pages lose their in-page Write button.

**Verify:**

- **`test/web/document.test.ts`** gets these cases:
  - the console marks the current section, and renders the subnav only when `mailboxes` is set, with `aria-current="page"` on the current mailbox;
  - a success flash renders the toast (`role="status"`) and an error flash the inline `role="alert"`;
  - `approval` renders the column with the brand bar, and `auth`/`static` render the card;
  - every `<svg` in a rendered page has `aria-hidden="true"`;
  - no `style=` appears anywhere.
- The `mail.test.ts` nav regex passes unchanged.
- Full `pnpm test`: the browser suite's 44px, focus, 320px and dark checks still pass with the old page markup inside the new layouts.
- Stack evaluation (memory): `node --import ./node_modules/alchemy/bin/register-oxc.js -e 'import("./alchemy.run.ts")'`.

**Done:** yes. Notes:

- Console content is capped at a `--content` width (60rem) in place of the mockup's `.narrow`; the toolbar pads its end with `100cqi` so its actions line up with the content's right edge.
- The reveal rule sits in `components`, after `.field`, since a `display` in a later layer would otherwise override it.
- `contactHtml` lost its `contact` class, which the vocabulary doesn't have.
- The compose route's helper is `sidebarMailboxes`, so the task 8 search for `mailboxNav` stays empty.
- Under machine load, two or three account worker specs (`queries`, `receipts`) hit their 5s timeout in the full run; they pass when rerun alone, and this change doesn't touch them.

### 3. Mail list and conversation

**Start in:** `web/pages/mail.ts`.

- **`mailListPage`**
  - Heading: the mailbox address, or "All mailboxes". No lede.
  - `<ul class="threads">`, with one `<li><a class="thread[ unread]">` per thread. Each row holds:
    - `<span class="dot">`;
    - `<span class="who">` with `<b>` for the sender and `<small>` for the message count when it is above 1;
    - `<span class="what">` with the subject, plus a `.chip` with each involved mailbox's local part and "@" (only in the all-mailboxes view);
    - `shortTimeHtml(lastActivityAt)`.
  - Empty state: `<p class="empty">No conversations here yet.</p>`.
  - "Older" becomes `<div class="pager"><a class="button secondary">Older{icon right}</a></div>`, right-aligned.
- **`threadPage`**
  - **Toolbar**, each action as an icon plus a `.label`:
    - `<a class="button quiet" href="/mail">` back to "All mailboxes";
    - Reply (primary);
    - Reply all (`secondary`);
    - the Mark unread form (`secondary`);
    - Delete… (`danger`).
  - The delete popover keeps its forms, with `Delete` as `button danger solid` and Cancel as `button secondary`.
  - **Page head:** `h1` is the subject. The lede is "N messages" plus a `.chip` with the open message's mailbox address.
  - `<ol class="messages">` holds:
    - **Collapsed rows:** `<a class="message-row">` with an avatar (`initials(contactName(from))`), `<b>` with the sender and `shortTimeHtml`.
    - **The open message:** `<article class="message" id="open-message">`, containing:
      - `.message-head`: avatar, sender name with the address (`mono muted`), a "to …, cc …" line of `contactName`s (each through `bidiText`), and the time;
      - `<details class="more"><summary>Details</summary><dl class="meta">…</dl></details>`, with today's rows;
      - the images note as `<p class="note">{icon eye-off}Images are not shown. Inline images are listed as attachments below.</p>`;
      - the `.frame` iframe, unchanged;
      - the plain-text `<details class="more">`;
      - `<ul class="files" aria-label="Attachments">` of links with `{icon clip}`, the name and the size.
  - The "Attachments" `h2` is removed.

**Verify:**

- `mail.test.ts`: update line 60's pattern to `class="thread unread"`. Everything else passes unchanged ("Images are not shown." included).
- Add one assertion that the all-mailboxes list contains `class="chip">probe@` and the single-mailbox list doesn't. Match the chip markup, because the heading and the nav contain `probe@` too.
- Full `pnpm test`, including the `mail-thread` browser fixture (one `h1` holds the hostile subject, times are localized, no overflow).

**Done:** yes. The open message's header shows its time in the full format; list and collapsed rows use `shortTimeHtml`.

### 4. Compose and send status

**Start in:** `web/pages/compose.ts`.

- **`composePage`**
  - Heading: "New message", "Reply" or "Reply all", as today.
  - `<form class="composer">`:
    - one `.compose-row` per field (`<label>` plus control): From `<select>`, To, Cc and Subject. The ids, names and values stay as they are;
    - errors as `<p class="error" role="alert">` in the row's second column;
    - a reply shows read-only rows instead: From (`mono`), and To and Cc through `contactListHtml`;
    - the hidden inputs are unchanged;
    - `<label class="sr-only" for="text">Message</label>` and the `#text` textarea;
    - `.composer-foot`: Send (primary, `{icon send}`), a Cancel link (`button quiet`) and `<small class="muted">Plain text</small>`.
- **`sentPage`**
  - Heading "Send status", with the lede as today's badge.
  - Main: the explanation `<p>`, then `.actions` with Open conversation (primary) and Refresh (`secondary`).

**Verify:** `compose.test.ts` passes unchanged. Then the full `pnpm test` (the browser textarea-growth check and the 320px check).

**Done:** yes. A message error sits under the textarea inside the sheet.

### 5. Mailboxes and mailbox detail

**Start in:** `web/pages/mailboxes.ts`.

- **`mailboxesPage`**
  - `<ul class="rows">` of `<a class="row">`, each with:
    - first line: the `mono` address plus the Active/Inactive badge, with the badge markup unchanged;
    - second line: the display name, then "· forwards to …".
  - Below the list, `<div class="settings"><section class="setting" aria-labelledby="new-mailbox-title">`:
    - header: `h2` "New mailbox" and "Receives mail at @{domain}.";
    - body: the form, with the `.suffixed` address input, Display name, and Create mailbox (primary).
- **`mailboxPage`**
  - Toolbar: `<nav class="crumbs">` with a Mailboxes link, `{icon right}` and the address. Page head: the address, with the badge as the lede.
  - `<div class="settings">` with two sections:
    - **General:** the display name field with its hint, then Active as `<label class="switch-row"><span><b>Active</b><small>…</small></span><input class="switch" type="checkbox" name="active"></label>`, then Save.
    - **Forwarding:** the status sentence, the Forward to field, then an `.actions` row holding the Forward/Change submit and, when forwarding is set, the separate "Stop forwarding" form (`button danger`).

**Verify:** `mailboxes.test.ts` passes unchanged (the badge strings stay). Then the full `pnpm test`.

**Done:** yes. Deviation: "Stop forwarding" is a second submit button in the forwarding form (`name="remove" value="1" formnovalidate`) rather than a separate form, which puts both buttons in one `.actions` row without nesting forms. The route already treats any `remove` field as the stop request.

### 6. Clients, client detail and the shared access sections

**Start in:** `web/pages/clients.ts`.

- **`accessFieldsets`** (shared with consent) returns `<section class="setting">` blocks in place of today's bare fieldsets. Each block is:
  - `<header>` with an `h2` (with an id) and a hint `<p>`: Mailboxes "Which mailboxes it can see and send from.", Sending "Whether its messages wait for you.";
  - `<fieldset aria-labelledby="{h2 id}">` holding `.choices`, the `.revealed` part and the field error.
  - The mailbox checkboxes become `<ul class="checklist revealed">` rows. The radio `name`/`value`s, `data-reveal`, `#preapproved` and the hint id stay.
  - `recipientsFieldset` follows the same shape: Recipients "Who it may write to."
  - `choice()` renders `<label class="choice"><input …><b>{label}</b><small>{hint}</small></label>`.
- **`clientsPage`:** `.rows` of `<a class="row">`, with the name plus the badge (markup unchanged) and the summary as the second line.
- **`clientPage`**
  - Toolbar: crumbs for Clients and the name. The lede is the badge plus the `mono muted` client id.
  - `<form class="settings">`: the access sections, a Reading section (`switch-row` with `name="canRead"`), the Recipients section, then `.actions` with the save button.
  - The CLI client keeps its muted sentence in place of the form.
  - Revoke becomes `<div class="danger-zone">`, holding the `<b>` title and `<p>` text on one side and the `Revoke access…` button on the other. The `#revoke-dialog` popover keeps its form, styled like the delete dialog.

**Verify:** `clients.test.ts` passes unchanged. Then the full `pnpm test`, including the `client` browser fixture:

- `#preapproved` shows only under "With my approval";
- the `sendMode=deny` radio is reachable by keyboard;
- the popover opens by keyboard.

**Done:** yes. The consent port from task 7 was pulled forward: once `accessFieldsets` returned settings sections, consent overflowed at 320px until they sat in its `.settings` container. The client form's save row is right-aligned (`.settings > .actions`), in the controls column as in the mockup.

### 7. Login, consent, device, notices and approval

**Start in:** `web/pages/login.ts`, then `consent.ts`, `device.ts`, `notice.ts` and `approval.ts`.

- **Login:** the fields in the card, then `<button id="login-submit" class="button">` (full width through `.card .button`), then `#status`. The scripts are unchanged.
- **Consent:**
  - card lede as today;
  - `.meta` (Client, Access, Returns to) unchanged;
  - `<div class="settings">{accessFieldsets}</div>`;
  - `.actions` with `#accept` (primary), then `#deny` (`secondary`), both `type="button"`;
  - `#status`.
- **Device:**
  - the code moves out of `.meta` into `<p class="code">{bidiAddress(userCode)}</p>`;
  - `.meta` keeps Client, Scope and Resource;
  - `.actions` with Approve CLI access (primary), then Deny request (`secondary`).
- **Notice:** `main` is `{icon alert or check}` plus `<p role="alert|status">`. No `.note` box.
- **Approval (`approvalReviewPage`)**
  - Page head: the heading and lede from `statePresentation`.
  - A `.summary` card with:
    - a first line with the state badge, plus `{icon clock}expires in …` while pending;
    - `.avatar` (`initials(requester.label)`) and "{requester} wants to send";
    - the subject;
    - the existing `.meta`, rows unchanged (see **Invariants**).
  - `<section id="message-body" aria-labelledby="message-body-title">`:
    - `<h2 class="section-label" id="message-body-title">Message body</h2>`;
    - the remote-images note as `note warning` with `{icon alert}`, copy unchanged;
    - the preview iframe, unchanged;
    - the plain-text `details.more`.
  - `<section id="decision" class="decision" aria-labelledby="decision-title">`, not sticky:
    - `<h2 class="sr-only" id="decision-title">Choose what happens next</h2>`;
    - the sentence;
    - one `<form method="post" class="actions">` with Approve &amp; send (primary), then Deny request (`secondary`).
  - `summaryHtml` and `metadataHtml` merge into one `summaryHtml`. Delete the old "Message details" section.

**Verify:**

- `approval-flow.test.ts`, `document.test.ts` (the login label case) and the `session`/`oauth`/`static-client` tests pass unchanged.
- Full `pnpm test`, including every browser expectation for login, consent, pending and decided approvals and the notices:
  - button lists and order;
  - one form;
  - focus order;
  - 44px controls;
  - `.meta` counts;
  - `sectionsSeparated`;
  - no CSP violations;
  - 320px.

**Done:** yes. Consent was ported in task 6. Two changes from the plan:

- `approval-flow.test.ts` could not stay unchanged: its remote-images check expected the note's text right after `role="note">`, and the plan puts the alert icon there. The regex now allows that one icon before the text.
- A notice's message is `<p class="lede" role="alert|status">` with the icon inside it, so the icon sits beside the text rather than on its own row in the card.
- In the approval summary, the subject is an `h2`, and the requester line and avatar sit outside the `.meta`, whose rows and counts are unchanged.

### 8. Final sweep and docs

- **Two-way class check.** Write a one-off script, not committed:
  - collect every class selector in `styles.ts`;
  - collect every class name the markup can produce: the `class="…"` tokens in `web/**/*.ts`, plus the string literals that feed class attributes (the `JOB_STATES` tones, the badge tones in `approval.ts`, the flash and notice tones, `unread`);
  - both differences must be empty. List anything the script can't see, and check it by hand.
- **Old names are gone:** this search returns nothing:
  - `rg -n 'wordmark|console-grid|console-body|nav-list|--paper|--ink\b|--rule|--font-serif|--step-|--space-|mailboxNav|composeAside|contactsHtml|class="panel|class="list|class="section' apps/server`
- **No inline styles:** `rg 'style="' apps/server/src/web` returns nothing.
- **No unused code:** `pnpm lint` reports no unused exports or icons.
- **Delete** `adrs/0004-minimal-web-ui.mockup.html`.
- **Docs:** fill in this plan's Done notes. README and `docs/` describe no styling, so they don't change.

**Verify:** `pnpm fmt` on `apps/server`, `pnpm lint`, `pnpm typecheck` and the full `pnpm test`.

**Done:** no.

## Owner's manual QA after deploy

- Light and dark mode, and a phone width, on:
  - `/mail`;
  - a real HTML newsletter;
  - a plain-text mail;
  - compose;
  - `/mailboxes` and one mailbox;
  - `/clients` and one client.
- Sign out and sign in again. Check that the success toast fades out and that an error, such as an invalid forward address, stays visible.
- Trigger a real approval: review the page, and approve or deny from the bottom.
- Connect an MCP client and check the consent card. Run `umail` login for the device page.

## Open questions

None. The owner approved the ADR on 2026-09-25 and kept the approval decision after the body, not pinned.
