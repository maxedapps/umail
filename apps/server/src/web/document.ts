import type {
  Address,
  ApprovalPreviewHeaders,
  ApprovalTrustedPageHeaders,
} from "@umail/api-contract";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { PRODUCT_NAME, productPageTitle } from "../api/brand/identity.ts";
import { html, htmlText, trustedHtml, type Html } from "./html.ts";
import { icon, logo } from "./icons.ts";
import { styles } from "./styles.ts";

// What a page may do, which sets its CSP and its layout: console pages get the sidebar, approval
// pages a single column, and every other kind a centred card.
export type PageKind = "auth" | "console" | "form" | "approval" | "static";

export type ConsoleSection = "mail" | "mailboxes" | "clients";

export type Flash = { readonly tone: "success" | "error"; readonly message: string };

export type PageView = {
  readonly kind: PageKind;
  readonly title: string;
  readonly heading: string;
  readonly lede?: Html | string | undefined;
  readonly main: Html;
  readonly flash?: Flash | undefined;
  // Auth pages only: their own script. Console pages always get the time script.
  readonly script?: string | undefined;
  readonly section?: ConsoleSection | undefined;
  // Console only: a back link or breadcrumbs, then actions, in a sticky bar above the content.
  readonly toolbar?: Html | undefined;
  // Mail pages only: the mailboxes nested under Mail in the sidebar.
  readonly mailboxes?: MailboxNav | undefined;
};

// The mailboxes nested under Mail, and the list being read: "all", a mailbox id, or null.
export type MailboxNav = {
  readonly addresses: ReadonlyArray<Address>;
  readonly current: string | null;
};

type PageStatus = 200 | 400 | 401 | 403 | 404 | 409 | 410 | 500 | 502;

type KindPolicy = {
  readonly script: boolean;
  readonly connect: "'self'" | "'none'";
  readonly formAction: "'self'" | "'none'";
  readonly frame: "'self'" | "'none'";
};

const KIND_POLICIES = {
  auth: { script: true, connect: "'self'", formAction: "'self'", frame: "'none'" },
  console: { script: true, connect: "'none'", formAction: "'self'", frame: "'self'" },
  form: { script: false, connect: "'none'", formAction: "'self'", frame: "'none'" },
  approval: { script: false, connect: "'none'", formAction: "'self'", frame: "'self'" },
  static: { script: false, connect: "'none'", formAction: "'none'", frame: "'none'" },
} satisfies Record<PageKind, KindPolicy>;

const PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

// Shows every `<time>` in the viewer's zone; the server's UTC text stays as the title. A
// `data-short` time shows only the time today, the day this year, and the date before that.
const TIME_SCRIPT = `
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const now = new Date();
for (const time of document.querySelectorAll("time[datetime]")) {
  const at = new Date(time.dateTime);
  if (Number.isNaN(at.getTime())) continue;
  time.title = time.textContent;
  time.textContent = !time.hasAttribute("data-short")
    ? full.format(at)
    : at.toDateString() === now.toDateString()
      ? clock.format(at)
      : at.getFullYear() === now.getFullYear()
        ? day.format(at)
        : date.format(at);
}
`;

export const pageNonce = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return Encoding.encodeHex(yield* crypto.randomBytes(16));
}).pipe(Effect.orDie);

export function renderDocument(view: PageView, nonce: string): string {
  const policy = KIND_POLICIES[view.kind];
  const script = view.kind === "console" ? TIME_SCRIPT : view.script;
  const scriptHtml = policy.script && script !== undefined ? scriptElement(nonce, script) : null;
  const lede = view.lede === undefined ? null : html`<p class="lede">${view.lede}</p>`;
  const flash = view.flash?.tone === "error" ? flashHtml(view.flash.message) : null;
  const pageHead = html`<div class="page-head">
    <h1>${view.heading}</h1>
    ${lede}
  </div>`;
  const body =
    view.kind === "console"
      ? html`<body class="console">
          ${sidebarHtml(view)}
          <main>
            ${view.toolbar === undefined ? null : html`<div class="toolbar">${view.toolbar}</div>`}
            <div class="content">${pageHead} ${flash} ${view.main}</div>
            ${view.flash?.tone === "success" ? toastHtml(view.flash.message) : null}
          </main>
          ${scriptHtml}
        </body>`
      : view.kind === "approval"
        ? html`<body class="focus">
            <header class="focus-bar">${logo}${PRODUCT_NAME} <small>Send approval</small></header>
            <main class="column">${pageHead} ${flash} ${view.main}</main>
          </body>`
        : html`<body class="focus">
            <main>
              <div class="card">
                <header>
                  ${logo}
                  <h1>${view.heading}</h1>
                  ${lede}
                </header>
                ${flash} ${view.main}
              </div>
            </main>
            ${scriptHtml}
          </body>`;
  return htmlText(html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow,noarchive" />
        <title>${productPageTitle(view.title)}</title>
        <style nonce="${nonce}">
          ${trustedHtml(styles)}
        </style>
      </head>
      ${body}
    </html>`);
}

// On mail pages Mail is the section (stronger text) and the mailbox being read is the page (a fill).
function sidebarHtml(view: PageView): Html {
  const current = (section: ConsoleSection) => (section === view.section ? "page" : "false");
  return html`<aside class="sidebar">
    <a class="brand" href="/mail">${logo}${PRODUCT_NAME}</a>
    <a class="compose" href="/mail/compose">${icon("pen")}Write</a>
    <nav class="nav" aria-label="Console">
      <a href="/mail" aria-current="${view.section === "mail" ? "true" : "false"}"
        >${icon("inbox")}Mail</a
      >
      ${view.mailboxes === undefined ? null : subnavHtml(view.mailboxes)}
      <a href="/mailboxes" aria-current="${current("mailboxes")}">${icon("at")}Mailboxes</a>
      <a href="/clients" aria-current="${current("clients")}">${icon("key")}Clients</a>
    </nav>
    <form class="sidebar-foot" method="post" action="/logout">
      <span>Operator</span>
      <button class="button quiet icon-only" type="submit">
        ${icon("logout")}<span class="sr-only">Sign out</span>
      </button>
    </form>
  </aside>`;
}

function subnavHtml(nav: MailboxNav): Html {
  const link = (href: string, label: Html | string, selected: boolean) =>
    html`<li><a href="${href}" aria-current="${selected ? "page" : "false"}">${label}</a></li>`;
  return html`<ul class="subnav">
    ${link("/mail", "All mailboxes", nav.current === "all")}
    ${nav.addresses.map((address) =>
      link(
        `/mail?mailbox=${encodeURIComponent(address.id)}`,
        html`<span class="mono">${address.address}</span>`,
        nav.current === address.id,
      ),
    )}
  </ul>`;
}

// A plain template: Oxc rewrites a tagged template that contains a closing script tag into a helper
// call, which alchemy's Node loader cannot resolve when it evaluates the stack.
function scriptElement(nonce: string, script: string): Html {
  return trustedHtml(`<script nonce="${nonce}">${script}</script>`);
}

// Errors stay in the page; a success is a toast that fades out on its own.
function flashHtml(message: string): Html {
  return html`<p class="flash" role="alert">${icon("alert")}${message}</p>`;
}

function toastHtml(message: string): Html {
  return html`<p class="toast" role="status">${icon("check")}${message}</p>`;
}

export function pageHeaders(kind: PageKind, nonce: string): typeof ApprovalTrustedPageHeaders.Type {
  const policy = KIND_POLICIES[kind];
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    `connect-src ${policy.connect}`,
    "font-src 'none'",
    `form-action ${policy.formAction}`,
    "frame-ancestors 'none'",
    `frame-src ${policy.frame}`,
    "img-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src ${policy.script ? `'nonce-${nonce}'` : "'none'"}`,
    `style-src 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "worker-src 'none'",
  ].join("; ");
  return {
    "cache-control": "no-store",
    "content-security-policy": csp,
    "content-type": "text/html; charset=utf-8",
    "permissions-policy": PERMISSIONS_POLICY,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow, noarchive",
  };
}

export const htmlResponse = Effect.fn("htmlResponse")(function* (
  status: PageStatus,
  view: PageView,
) {
  const nonce = yield* pageNonce;
  return HttpServerResponse.text(renderDocument(view, nonce), {
    status,
    contentType: "text/html; charset=utf-8",
    headers: pageHeaders(view.kind, nonce),
  });
});

// The same page as the body and headers an `HttpApi` endpoint or error declares.
export const approvalHttpApiBody = Effect.fn("approvalHttpApiBody")(function* (view: PageView) {
  const nonce = yield* pageNonce;
  return { body: renderDocument(view, nonce), headers: pageHeaders(view.kind, nonce) };
});

export function redirect(location: string) {
  return HttpServerResponse.redirect(location, {
    status: 303,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

// A stored mail body, framed by a sandboxed iframe, for approval review and the console. Its styles
// are inline attributes, which only this document's own policy allows; it never runs script, submits
// forms or loads anything, images included.
export const BODY_FRAME_CSP =
  "default-src 'none'; sandbox; frame-ancestors 'self'; script-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; style-src-elem 'none'; style-src-attr 'unsafe-inline'";

export function bodyDocument(storedHtml: string): string {
  return htmlText(html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow,noarchive" />
        <title>Email body</title>
      </head>
      <body>
        ${trustedHtml(storedHtml)}
      </body>
    </html>`);
}

export function bodyFrameHeaders(csp: string): typeof ApprovalPreviewHeaders.Type {
  return {
    "cache-control": "no-store",
    "content-security-policy": csp,
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}
