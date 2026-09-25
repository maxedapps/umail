import { PRODUCT_NAME } from "../../brand/identity.ts";

const HTML_TEXT_REPLACEMENTS = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
] as const;

const MAIL_LEDGER_STYLESHEET = `
:root {
  color-scheme: light dark;
  --paper: #f4efe4;
  --paper-raised: #fffaf0;
  --ink: #27231f;
  --ink-muted: #6f665d;
  --rule: #c7bba9;
  --rule-strong: #8f8172;
  --accent: #7a2530;
  --accent-strong: #581720;
  --accent-ink: #fffaf3;
  --error: #9a2734;
  --success: #2f634c;
  --shadow: 0 1.25rem 3.5rem rgb(65 48 31 / 12%);
  --radius: 0.875rem;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

* {
  box-sizing: border-box;
}

html {
  min-width: 20rem;
  background: var(--paper);
}

body {
  min-height: 100vh;
  margin: 0;
  color: var(--ink);
  background:
    linear-gradient(90deg, transparent 0 1.5rem, rgb(122 37 48 / 8%) 1.5rem 1.5625rem, transparent 1.5625rem),
    repeating-linear-gradient(0deg, transparent 0 2.5rem, rgb(84 69 53 / 5%) 2.5rem 2.5625rem),
    var(--paper);
}

button,
input,
select {
  font: inherit;
}

button,
input[type="email"],
input[type="password"] {
  min-height: 2.75rem;
}

button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 7.5rem;
  padding: 0.6875rem 1.125rem;
  border: 1px solid var(--accent-strong);
  border-radius: 0.45rem;
  color: var(--accent-ink);
  background: var(--accent);
  box-shadow: 0 0.2rem 0 var(--accent-strong);
  font-weight: 720;
  line-height: 1.15;
  cursor: pointer;
  transition: transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
}

button:hover:not(:disabled) {
  background: var(--accent-strong);
  transform: translateY(-1px);
}

button:active:not(:disabled) {
  box-shadow: none;
  transform: translateY(0.2rem);
}

button:disabled {
  cursor: wait;
  opacity: 0.62;
}

.button--secondary {
  border-color: var(--rule-strong);
  color: var(--ink);
  background: transparent;
  box-shadow: 0 0.2rem 0 var(--rule);
}

.button--secondary:hover:not(:disabled) {
  background: rgb(111 102 93 / 10%);
}

:focus-visible {
  outline: 0.2rem solid var(--accent);
  outline-offset: 0.2rem;
}

.site-header,
.site-footer,
.page-shell {
  width: min(100% - 2rem, 68rem);
  margin-inline: auto;
}

.site-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding-block: 1.25rem;
  border-bottom: 1px solid var(--rule-strong);
}

.wordmark {
  display: inline-flex;
  align-items: center;
  gap: 0.625rem;
  color: var(--ink);
  font-size: 0.98rem;
  font-weight: 780;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.wordmark__seal {
  display: inline-grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 1px solid var(--accent);
  border-radius: 50%;
  color: var(--accent);
  font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.66rem;
  letter-spacing: 0;
}

.site-header__descriptor,
.site-footer {
  color: var(--ink-muted);
  font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.page-shell {
  display: grid;
  min-height: calc(100vh - 10rem);
  place-items: center;
  padding-block: clamp(2rem, 8vw, 6rem);
}

.page-card {
  width: min(100%, 42rem);
  padding: clamp(1.35rem, 4vw, 3rem);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--paper-raised) 96%, transparent);
  box-shadow: var(--shadow);
}

.page-card::before {
  display: block;
  width: 4.5rem;
  height: 0.25rem;
  margin-bottom: 1.5rem;
  background: var(--accent);
  content: "";
}

.eyebrow {
  margin: 0 0 0.55rem;
  color: var(--accent);
  font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.76rem;
  font-weight: 760;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}

h1 {
  max-width: 19ch;
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2rem, 8vw, 3.55rem);
  font-weight: 560;
  letter-spacing: -0.035em;
  line-height: 0.98;
}

.lede {
  max-width: 55ch;
  margin: 1.15rem 0 2rem;
  color: var(--ink-muted);
  font-size: 1.02rem;
  line-height: 1.65;
}

.auth-form,
.consent-details,
.notice-panel {
  padding-top: 1.5rem;
  border-top: 1px solid var(--rule);
}

.field {
  display: grid;
  gap: 0.45rem;
  margin-bottom: 1.1rem;
}

.field__label,
.consent-details dt {
  color: var(--ink-muted);
  font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.75rem;
  font-weight: 720;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.field input[type="email"],
.field input[type="password"],
.field input[type="text"],
.field select {
  width: 100%;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--rule-strong);
  border-radius: 0.4rem;
  color: var(--ink);
  background: var(--paper-raised);
  caret-color: var(--accent);
}

.field input:hover,
.field select:hover {
  border-color: var(--accent);
}

.checkbox-field {
  display: grid;
  grid-template-columns: 1.4rem 1fr;
  gap: 0.6rem;
  align-items: start;
  margin: 1.25rem 0;
  color: var(--ink-muted);
  line-height: 1.45;
}

.checkbox-field input {
  width: 1.2rem;
  height: 1.2rem;
  margin: 0.08rem 0 0;
  accent-color: var(--accent);
}

.form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}

.status-message {
  min-height: 1.5rem;
  margin: 1rem 0 0;
  color: var(--ink-muted);
  font-weight: 650;
  line-height: 1.45;
}

.status-message[data-kind="error"] {
  color: var(--error);
}

.status-message[data-kind="success"] {
  color: var(--success);
}

.consent-details {
  display: grid;
  grid-template-columns: minmax(6rem, max-content) minmax(0, 1fr);
  gap: 0.8rem 1rem;
  margin: 0 0 1.5rem;
}

.consent-details dt,
.consent-details dd {
  margin: 0;
}

.consent-details dd {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 650;
}

.review-section {
  padding-block: 1.5rem;
  border-top: 1px solid var(--rule);
}

.review-section:last-child {
  padding-bottom: 0;
}

.review-section h2 {
  margin: 0 0 1rem;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.35rem;
  font-weight: 600;
}

.message-details {
  display: grid;
  grid-template-columns: minmax(7rem, max-content) minmax(0, 1fr);
  gap: 0.65rem 1rem;
  margin: 0;
}

.message-details dt,
.message-details dd {
  margin: 0;
}

.message-details dt {
  color: var(--ink-muted);
  font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.75rem;
  font-weight: 720;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.message-details dd,
.contact,
.contact-list {
  min-width: 0;
  overflow-wrap: anywhere;
}

.contact-list {
  display: grid;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.message-preview {
  isolation: isolate;
}

.message-text,
.message-frame {
  width: 100%;
  margin: 0;
  border: 1px solid var(--rule-strong);
  border-radius: 0.4rem;
  background: var(--paper-raised);
}

.message-text {
  max-height: 30rem;
  padding: 1rem;
  overflow: auto;
  color: var(--ink);
  font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.875rem;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.message-frame {
  min-height: 24rem;
}

.text-alternative {
  margin-top: 1rem;
}

.text-alternative summary {
  min-height: 2.75rem;
  padding-block: 0.7rem;
  color: var(--accent);
  font-weight: 720;
  cursor: pointer;
}

.decision-panel p,
.empty-value {
  color: var(--ink-muted);
  line-height: 1.6;
}

.notice-panel {
  line-height: 1.65;
}

.notice-panel p {
  margin: 0;
}

.site-footer {
  padding-block: 1.25rem 2rem;
  border-top: 1px solid var(--rule);
}

bdi[dir="ltr"] {
  direction: ltr;
  unicode-bidi: isolate;
}

@media (max-width: 36rem) {
  body {
    background:
      repeating-linear-gradient(0deg, transparent 0 2.5rem, rgb(84 69 53 / 5%) 2.5rem 2.5625rem),
      var(--paper);
  }

  .site-header__descriptor {
    display: none;
  }

  .page-card {
    border-inline: 0;
    border-radius: 0;
  }

  .consent-details {
    grid-template-columns: 1fr;
    gap: 0.3rem;
  }

  .consent-details dd {
    margin-bottom: 0.7rem;
  }

  .message-details {
    grid-template-columns: 1fr;
    gap: 0.25rem;
  }

  .message-details dd {
    margin-bottom: 0.7rem;
  }

  .form-actions,
  .form-actions button {
    width: 100%;
  }
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #191817;
    --paper-raised: #252220;
    --ink: #f0e8dd;
    --ink-muted: #bbb0a4;
    --rule: #514940;
    --rule-strong: #766a5e;
    --accent: #d2737f;
    --accent-strong: #e09aa3;
    --accent-ink: #201214;
    --error: #ff8b98;
    --success: #88c5a8;
    --shadow: 0 1.25rem 3.5rem rgb(0 0 0 / 32%);
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}

@media (forced-colors: active) {
  :root {
    --paper: Canvas;
    --paper-raised: Canvas;
    --ink: CanvasText;
    --ink-muted: CanvasText;
    --rule: CanvasText;
    --rule-strong: CanvasText;
    --accent: LinkText;
    --accent-strong: LinkText;
    --accent-ink: Canvas;
    --error: Mark;
    --success: CanvasText;
    --shadow: none;
  }

  button,
  input {
    forced-color-adjust: auto;
  }
}
`;

const RenderedHumanPageTypeId = Symbol("umail/RenderedHumanPage");

type HumanPageStatus = 200 | 400 | 403 | 404 | 410 | 500;

export type HumanPagePolicy = "static" | "auth" | "approvalReview";

export type RenderedHumanPage<Status extends HumanPageStatus = HumanPageStatus> = {
  readonly [RenderedHumanPageTypeId]: true;
  readonly status: Status;
  readonly policy: HumanPagePolicy;
  readonly nonce: string;
  readonly html: string;
};

type HumanPageDocumentView = {
  readonly title: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly description: string;
  readonly mainHtml: string;
  readonly script?: string | undefined;
};

type HumanPageInternalView<Status extends HumanPageStatus> = {
  readonly status: Status;
  readonly policy: HumanPagePolicy;
  readonly document: HumanPageDocumentView;
};

function createHumanPageNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let nonce = "";
  for (const byte of bytes) {
    nonce += byte.toString(16).padStart(2, "0");
  }
  return nonce;
}

export function renderHumanPageInternal<Status extends HumanPageStatus>(
  view: HumanPageInternalView<Status>,
): RenderedHumanPage<Status> {
  const nonce = createHumanPageNonce();
  return {
    [RenderedHumanPageTypeId]: true,
    status: view.status,
    policy: view.policy,
    nonce,
    html: renderHumanPageDocument(view.document, nonce),
  };
}

function renderHumanPageDocument(view: HumanPageDocumentView, nonce: string): string {
  let scriptHtml = "";
  if (view.script !== undefined) {
    scriptHtml = `<script nonce="${escapeHtmlText(nonce)}">${view.script}</script>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>${escapeHtmlText(view.title)}</title>
  <style nonce="${escapeHtmlText(nonce)}">${MAIL_LEDGER_STYLESHEET}</style>
</head>
<body>
  <header class="site-header">
    <div class="wordmark" aria-label="${escapeHtmlText(PRODUCT_NAME)}">
      <span class="wordmark__seal" aria-hidden="true">AM</span>
      <span>${escapeHtmlText(PRODUCT_NAME)}</span>
    </div>
    <span class="site-header__descriptor">Private mail for agents</span>
  </header>
  <main class="page-shell">
    <section class="page-card" aria-labelledby="page-title">
      <p class="eyebrow">${escapeHtmlText(view.eyebrow)}</p>
      <h1 id="page-title">${escapeHtmlText(view.heading)}</h1>
      <p class="lede">${escapeHtmlText(view.description)}</p>
      ${view.mainHtml}
    </section>
  </main>
  <footer class="site-footer">${escapeHtmlText(PRODUCT_NAME)} · API / CLI / MCP first</footer>
  ${scriptHtml}
</body>
</html>`;
}

export function escapeHtmlText(value: string): string {
  let escaped = value;
  for (const [character, entity] of HTML_TEXT_REPLACEMENTS) {
    escaped = escaped.replaceAll(character, entity);
  }
  return escaped;
}
