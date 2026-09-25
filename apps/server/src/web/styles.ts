// The whole stylesheet. It is a module rather than a `.css` file because the stack is also evaluated
// in Node (alchemy deploy), whose loader cannot import `?raw`; see ADR 0003, amendment 1.
export const styles = String.raw`
@layer reset, tokens, base, layout, components;

@view-transition {
  navigation: auto;
}

@media (prefers-reduced-motion: reduce) {
  @view-transition {
    navigation: none;
  }
}

@layer reset {
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  body,
  h1,
  h2,
  h3,
  p,
  dl,
  dd,
  figure,
  pre {
    margin: 0;
  }

  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }

  img,
  iframe {
    display: block;
    max-inline-size: 100%;
  }
}

@layer tokens {
  :root {
    color-scheme: light dark;

    --paper: light-dark(oklch(97.5% 0.008 80), oklch(18% 0.006 60));
    --surface: light-dark(oklch(99.5% 0.003 80), oklch(22.5% 0.008 60));
    --sunken: light-dark(oklch(94.5% 0.01 80), oklch(15.5% 0.005 60));
    --ink: light-dark(oklch(24% 0.012 50), oklch(93% 0.012 80));
    --muted: light-dark(oklch(47% 0.015 50), oklch(73% 0.015 70));
    --rule: light-dark(oklch(88% 0.012 70), oklch(33% 0.01 60));
    --rule-strong: light-dark(oklch(72% 0.015 60), oklch(48% 0.012 60));
    --accent: light-dark(oklch(42% 0.14 15), oklch(74% 0.12 15));
    --accent-hover: light-dark(oklch(35% 0.13 15), oklch(81% 0.1 15));
    --accent-ink: light-dark(oklch(99% 0.005 80), oklch(19% 0.03 15));
    --accent-soft: light-dark(oklch(94% 0.03 15), oklch(30% 0.05 15));
    --success: light-dark(oklch(44% 0.09 155), oklch(78% 0.1 155));
    --success-soft: light-dark(oklch(94% 0.035 155), oklch(28% 0.04 155));
    --warning: light-dark(oklch(48% 0.1 70), oklch(82% 0.11 80));
    --warning-soft: light-dark(oklch(95% 0.045 85), oklch(29% 0.04 80));
    --danger: light-dark(oklch(46% 0.17 25), oklch(74% 0.14 25));
    --danger-soft: light-dark(oklch(94% 0.035 25), oklch(29% 0.06 25));

    --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-serif: Georgia, "Times New Roman", serif;
    --font-mono: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;

    --step--1: clamp(0.8rem, 0.78rem + 0.1vw, 0.86rem);
    --step-0: clamp(0.95rem, 0.92rem + 0.15vw, 1.03rem);
    --step-1: clamp(1.15rem, 1.08rem + 0.35vw, 1.35rem);
    --step-2: clamp(1.55rem, 1.35rem + 1vw, 2.2rem);

    --space-2xs: 0.25rem;
    --space-xs: 0.5rem;
    --space-s: clamp(0.75rem, 0.7rem + 0.25vw, 0.9rem);
    --space-m: clamp(1rem, 0.9rem + 0.5vw, 1.35rem);
    --space-l: clamp(1.5rem, 1.3rem + 1vw, 2.25rem);
    --space-xl: clamp(2rem, 1.6rem + 2vw, 3.5rem);

    --radius: 0.5rem;
    --control: 2.75rem;
  }

  @media (forced-colors: active) {
    :root {
      --paper: Canvas;
      --surface: Canvas;
      --sunken: Canvas;
      --ink: CanvasText;
      --muted: CanvasText;
      --rule: CanvasText;
      --rule-strong: CanvasText;
      --accent: LinkText;
      --accent-hover: LinkText;
      --accent-ink: Canvas;
      --accent-soft: Canvas;
      --success: CanvasText;
      --success-soft: Canvas;
      --warning: CanvasText;
      --warning-soft: Canvas;
      --danger: Mark;
      --danger-soft: Canvas;
    }
  }
}

@layer base {
  html {
    background: var(--paper);
    -webkit-text-size-adjust: 100%;
  }

  body {
    min-block-size: 100dvh;
    color: var(--ink);
    background: var(--paper);
    font-family: var(--font-sans);
    font-size: var(--step-0);
    line-height: 1.5;
    accent-color: var(--accent);
  }

  h1,
  h2,
  h3 {
    font-family: var(--font-serif);
    font-weight: 560;
    line-height: 1.15;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  h1 {
    font-size: var(--step-2);
  }

  h2 {
    font-size: var(--step-1);
  }

  h3 {
    font-size: var(--step-0);
  }

  p,
  li,
  dd {
    text-wrap: pretty;
  }

  a {
    color: var(--accent);
    text-underline-offset: 0.2em;

    &:hover {
      color: var(--accent-hover);
    }
  }

  :focus-visible {
    outline: 0.19rem solid var(--accent);
    outline-offset: 0.16rem;
  }

  code,
  .mono {
    font-family: var(--font-mono);
    font-size: 0.92em;
  }

  bdi[dir="ltr"] {
    unicode-bidi: isolate;
  }

  input:not([type="checkbox"], [type="radio"], [type="hidden"]),
  select,
  textarea {
    inline-size: 100%;
    min-block-size: var(--control);
    padding: var(--space-xs) var(--space-s);
    border: 1px solid var(--rule-strong);
    border-radius: calc(var(--radius) * 0.75);
    background: var(--surface);
    caret-color: var(--accent);

    &:hover {
      border-color: var(--accent);
    }

    &:user-invalid,
    &[aria-invalid="true"] {
      border-color: var(--danger);
      box-shadow: 0 0 0 1px var(--danger);
    }

    &:disabled,
    &[readonly] {
      color: var(--muted);
      background: var(--sunken);
    }
  }

  input[type="checkbox"],
  input[type="radio"] {
    inline-size: 1.15rem;
    block-size: 1.15rem;
    margin: 0;
    flex: none;
  }

  textarea {
    min-block-size: 12rem;
    max-block-size: 70dvh;
    field-sizing: content;
    resize: vertical;
  }

  fieldset {
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    padding: 0;
    margin-block-end: var(--space-xs);
    font-weight: 650;
  }

  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  [hidden] {
    display: none !important;
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
    }
  }
}

@layer layout {
  .wordmark {
    color: var(--ink);
    font-family: var(--font-serif);
    font-size: var(--step-1);
    font-weight: 600;
    text-decoration: none;

    &:hover {
      color: var(--accent);
    }
  }

  /* A centred narrow column: sign-in, consent, device, approval and notices. */
  .focus {
    display: grid;
    grid-template-rows: auto 1fr;
    padding-inline: 1rem;

    > header {
      inline-size: min(100%, 42rem);
      margin-inline: auto;
      padding-block: var(--space-m);
    }

    > main {
      inline-size: min(100%, 42rem);
      margin-inline: auto;
      padding-block: var(--space-m) var(--space-xl);
      display: grid;
      gap: var(--space-l);
      align-content: start;
    }
  }

  .page-head {
    display: grid;
    gap: var(--space-xs);

    > .lede {
      color: var(--muted);
      max-inline-size: 60ch;
    }
  }

  /* The console: header with nav and sign-out, then a sidebar and main that stack when narrow. */
  .console {
    > header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-xs) var(--space-m);
      padding: var(--space-xs) max(1rem, 3vw);
      border-block-end: 1px solid var(--rule);
      background: var(--surface);

      > nav {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2xs);
        margin-inline-end: auto;
      }

      nav a {
        display: inline-flex;
        align-items: center;
        min-block-size: var(--control);
        padding-inline: var(--space-s);
        border-radius: var(--radius);
        color: var(--muted);
        font-weight: 600;
        text-decoration: none;

        &:hover {
          color: var(--ink);
          background: var(--sunken);
        }

        &[aria-current="page"] {
          color: var(--accent);
          background: var(--accent-soft);
        }
      }
    }

    > .console-body {
      container: console / inline-size;
    }
  }

  .console-grid {
    display: grid;
    gap: var(--space-l);
    inline-size: min(100%, 78rem);
    margin-inline: auto;
    padding: var(--space-l) max(1rem, 3vw) var(--space-xl);

    > main {
      display: grid;
      gap: var(--space-l);
      align-content: start;
      min-inline-size: 0;
    }

    > aside {
      min-inline-size: 0;
    }
  }

  @container console (inline-size > 52rem) {
    .console-grid:has(> aside) {
      grid-template-columns: 15rem minmax(0, 1fr);
    }
  }

  .stack {
    display: grid;
    gap: var(--space-m);
    align-content: start;
  }

  .section {
    display: grid;
    gap: var(--space-s);
    padding-block-start: var(--space-m);
    border-block-start: 1px solid var(--rule);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-xs);
  }

  .split {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-xs) var(--space-m);
  }
}

@layer components {
  .button,
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-xs);
    min-block-size: var(--control);
    padding: var(--space-xs) var(--space-m);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    color: var(--accent-ink);
    background: var(--accent);
    font-weight: 650;
    line-height: 1.2;
    text-decoration: none;
    cursor: pointer;
    transition: background-color 120ms ease;

    &:hover:not(:disabled) {
      color: var(--accent-ink);
      background: var(--accent-hover);
    }

    &:disabled {
      cursor: wait;
      opacity: 0.6;
    }

    &.secondary {
      border-color: var(--rule-strong);
      color: var(--ink);
      background: transparent;

      &:hover:not(:disabled) {
        color: var(--ink);
        background: var(--sunken);
      }
    }

    &.danger {
      border-color: var(--danger);
      color: var(--danger);
      background: transparent;

      &:hover:not(:disabled) {
        color: var(--accent-ink);
        background: var(--danger);
      }
    }

    &.danger.solid {
      color: var(--accent-ink);
      background: var(--danger);
    }
  }

  .field {
    display: grid;
    gap: var(--space-2xs);

    > label,
    > .label {
      font-weight: 650;
    }

    > .hint {
      color: var(--muted);
      font-size: var(--step--1);
    }

    > .error {
      color: var(--danger);
      font-size: var(--step--1);
      font-weight: 600;
    }

    &:has(.error) :is(input, select, textarea) {
      border-color: var(--danger);
    }
  }

  .suffixed {
    display: flex;
    align-items: center;
    gap: var(--space-xs);

    > span {
      color: var(--muted);
      white-space: nowrap;
    }
  }

  /* A radio or checkbox as a card; the whole card is the label. */
  .choice {
    display: flex;
    align-items: start;
    gap: var(--space-s);
    min-block-size: var(--control);
    padding: var(--space-s);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--surface);
    cursor: pointer;

    > input {
      margin-block-start: 0.2rem;
    }

    > span {
      display: grid;
      gap: var(--space-2xs);
    }

    small {
      color: var(--muted);
      font-size: var(--step--1);
    }

    &:hover {
      border-color: var(--rule-strong);
    }

    &:has(input:checked) {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    &:has(input:focus-visible) {
      outline: 0.19rem solid var(--accent);
      outline-offset: 0.16rem;
    }
  }

  .choices {
    display: grid;
    gap: var(--space-xs);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
  }

  .checks {
    display: grid;
    gap: var(--space-2xs);
    padding-inline-start: var(--space-s);

    > label {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      min-block-size: var(--control);
      cursor: pointer;
    }
  }

  /* A fieldset shows its .revealed part only while the choice marked data-reveal is checked. */
  fieldset:not(:has(input[data-reveal]:checked)) .revealed {
    display: none;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.1rem 0.55rem;
    border: 1px solid currentColor;
    border-radius: 99rem;
    color: var(--muted);
    font-size: var(--step--1);
    font-weight: 650;
    white-space: nowrap;

    &.accent {
      color: var(--accent);
      background: var(--accent-soft);
    }

    &.success {
      color: var(--success);
      background: var(--success-soft);
    }

    &.warning {
      color: var(--warning);
      background: var(--warning-soft);
    }

    &.danger {
      color: var(--danger);
      background: var(--danger-soft);
    }
  }

  .flash,
  .note {
    padding: var(--space-s) var(--space-m);
    border: 1px solid var(--rule);
    border-inline-start-width: 0.3rem;
    border-radius: var(--radius);
    background: var(--surface);
  }

  .flash.success {
    border-color: var(--success);
    background: var(--success-soft);
  }

  .flash.error,
  .note.danger {
    border-color: var(--danger);
    background: var(--danger-soft);
  }

  .note.warning {
    border-color: var(--warning);
    background: var(--warning-soft);
  }

  .list {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--surface);

    > li + li {
      border-block-start: 1px solid var(--rule);
    }
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-2xs) var(--space-m);
    padding: var(--space-s) var(--space-m);
    color: inherit;
    text-decoration: none;

    &:is(a):hover {
      color: inherit;
      background: var(--sunken);
    }

    > .primary {
      display: flex;
      align-items: baseline;
      gap: var(--space-2xs) var(--space-xs);
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }

    > .secondary {
      grid-column: 1 / -1;
      color: var(--muted);
      font-size: var(--step--1);
      overflow-wrap: anywhere;
    }

    > .aside {
      color: var(--muted);
      font-size: var(--step--1);
      white-space: nowrap;
    }

    &.unread > .primary {
      font-weight: 700;
    }

    &.unread > .primary::before {
      flex: none;
      content: "";
      inline-size: 0.5rem;
      block-size: 0.5rem;
      align-self: center;
      border-radius: 50%;
      background: var(--accent);
    }
  }

  .empty {
    padding: var(--space-l);
    border: 1px dashed var(--rule-strong);
    border-radius: var(--radius);
    color: var(--muted);
    text-align: center;
  }

  .meta {
    display: grid;
    grid-template-columns: minmax(6rem, max-content) minmax(0, 1fr);
    gap: var(--space-xs) var(--space-m);

    > dt {
      color: var(--muted);
      font-size: var(--step--1);
      font-weight: 650;
      padding-block-start: 0.1rem;
    }

    > dd {
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }

    ul {
      display: grid;
      gap: var(--space-2xs);
      margin: 0;
      padding: 0;
      list-style: none;
    }
  }

  @container (inline-size < 30rem) {
    .meta {
      grid-template-columns: 1fr;
      gap: 0;

      > dd {
        margin-block-end: var(--space-xs);
      }
    }
  }

  .panel {
    display: grid;
    gap: var(--space-m);
    padding: var(--space-m);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--surface);
    container-type: inline-size;
  }

  .prose {
    padding: var(--space-m);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--surface);
    font-family: var(--font-sans);
    max-block-size: 40rem;
    overflow: auto;
  }

  .frame {
    inline-size: 100%;
    block-size: min(80dvh, 60rem);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: white;
  }

  details > summary {
    display: flex;
    align-items: center;
    min-block-size: var(--control);
    color: var(--accent);
    font-weight: 650;
    cursor: pointer;
  }

  .nav-list {
    display: grid;
    gap: var(--space-2xs);
    margin: 0;
    padding: 0;
    list-style: none;

    /* Narrow: the sidebar's links wrap into a row above the content. */
    @container console (inline-size <= 52rem) {
      display: flex;
      flex-wrap: wrap;
    }

    a {
      display: flex;
      align-items: center;
      min-block-size: var(--control);
      padding-inline: var(--space-s);
      border-radius: var(--radius);
      color: var(--ink);
      text-decoration: none;
      overflow-wrap: anywhere;

      &:hover {
        background: var(--sunken);
      }

      &[aria-current="page"] {
        color: var(--accent);
        background: var(--accent-soft);
        font-weight: 650;
      }
    }
  }

  [popover] {
    inline-size: min(100% - 2rem, 28rem);
    padding: var(--space-l);
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    color: var(--ink);
    background: var(--surface);
    box-shadow: 0 1rem 3rem oklch(0% 0 0 / 25%);

    &::backdrop {
      background: oklch(0% 0 0 / 35%);
    }

    > * + * {
      margin-block-start: var(--space-m);
    }
  }

  .muted {
    color: var(--muted);
  }

  .status {
    min-block-size: 1.5em;
    color: var(--muted);
    font-weight: 600;

    &[data-kind="error"] {
      color: var(--danger);
    }

    &[data-kind="success"] {
      color: var(--success);
    }
  }

  .contact {
    overflow-wrap: anywhere;
  }
}
`;
