import type { ApprovalPreviewHeaders, ApprovalTrustedPageHeaders } from "@umail/api-contract";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { PRODUCT_NAME, productPageTitle } from "../api/brand/identity.ts";
import { html, htmlText, trustedHtml, type Html } from "./html.ts";
import { styles } from "./styles.ts";

// What a page may do, which sets its CSP and its layout: console pages get the console chrome,
// every other kind the narrow focus column.
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
  readonly aside?: Html | undefined;
};

type PageStatus = 200 | 400 | 403 | 404 | 409 | 410 | 500;

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

// Shows every `<time>` in the viewer's zone; the server's UTC text stays as the fallback.
const TIME_SCRIPT = `
const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
for (const time of document.querySelectorAll("time[datetime]")) {
  const date = new Date(time.dateTime);
  if (Number.isNaN(date.getTime())) continue;
  time.title = time.textContent;
  time.textContent = format.format(date);
}
`;

const CONSOLE_NAV: ReadonlyArray<readonly [ConsoleSection, string, string]> = [
  ["mail", "Mail", "/mail"],
  ["mailboxes", "Mailboxes", "/mailboxes"],
  ["clients", "Clients", "/clients"],
];

export const pageNonce = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return Encoding.encodeHex(yield* crypto.randomBytes(16));
}).pipe(Effect.orDie);

export function renderDocument(view: PageView, nonce: string): string {
  const policy = KIND_POLICIES[view.kind];
  const script = view.kind === "console" ? TIME_SCRIPT : view.script;
  const head = html`<div class="page-head">
      <h1>${view.heading}</h1>
      ${view.lede === undefined ? null : html`<p class="lede">${view.lede}</p>`}
    </div>
    ${view.flash === undefined ? null : flashHtml(view.flash)} ${view.main}`;
  const body =
    view.kind === "console"
      ? html`<body class="console">
          <header>
            <a class="wordmark" href="/mail">${PRODUCT_NAME}</a>
            <nav aria-label="Console">
              ${CONSOLE_NAV.map(
                ([section, label, href]) =>
                  html`<a
                    href="${href}"
                    aria-current="${section === view.section ? "page" : "false"}"
                    >${label}</a
                  >`,
              )}
            </nav>
            <form method="post" action="/logout">
              <button class="secondary" type="submit">Sign out</button>
            </form>
          </header>
          <div class="console-body">
            <div class="console-grid">
              ${view.aside === undefined ? null : html`<aside>${view.aside}</aside>`}
              <main>${head}</main>
            </div>
          </div>
        </body>`
      : html`<body class="focus">
          <header><span class="wordmark">${PRODUCT_NAME}</span></header>
          <main>${head}</main>
        </body>`;
  return htmlText(html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>${productPageTitle(view.title)}</title>
  <style nonce="${nonce}">${trustedHtml(styles)}</style>
</head>
${body}
  ${policy.script && script !== undefined ? scriptElement(nonce, script) : null}
</body>
</html>`);
}

// A plain template: Oxc rewrites a tagged template that contains a closing script tag into a helper
// call, which alchemy's Node loader cannot resolve when it evaluates the stack.
function scriptElement(nonce: string, script: string): Html {
  return trustedHtml(`<script nonce="${nonce}">${script}</script>`);
}

function flashHtml(flash: Flash): Html {
  return html`<p class="flash ${flash.tone}" role="${flash.tone === "error" ? "alert" : "status"}">
    ${flash.message}
  </p>`;
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
