// The whole stylesheet. It is a module rather than a `.css` file because the stack is also evaluated
// in Node (alchemy deploy), whose loader cannot import `?raw`; see ADR 0003, amendment 1. The design
// is ADR 0004's: near-neutral greys, one accent, space and tone instead of borders.
export const styles = String.raw`
@layer reset, tokens, base, layout, components;

@view-transition {
  navigation: auto;
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
    interpolate-size: allow-keywords;

    --hue: 18;
    --bg: light-dark(oklch(99.4% 0.001 var(--hue)), oklch(15.5% 0.004 var(--hue)));
    --bg-subtle: light-dark(oklch(97.6% 0.003 var(--hue)), oklch(18% 0.004 var(--hue)));
    --surface: light-dark(oklch(100% 0 0), oklch(19.5% 0.005 var(--hue)));
    --hover: light-dark(oklch(95.6% 0.004 var(--hue)), oklch(23.5% 0.006 var(--hue)));
    --border: light-dark(oklch(91.5% 0.004 var(--hue)), oklch(27% 0.006 var(--hue)));
    --border-strong: light-dark(oklch(85% 0.005 var(--hue)), oklch(35% 0.007 var(--hue)));
    --text: light-dark(oklch(21% 0.006 var(--hue)), oklch(95.5% 0.003 var(--hue)));
    --text-2: light-dark(oklch(48% 0.008 var(--hue)), oklch(72% 0.007 var(--hue)));
    --text-3: light-dark(oklch(60% 0.008 var(--hue)), oklch(58% 0.007 var(--hue)));
    --primary: var(--text);
    --primary-ink: var(--bg);
    --accent: light-dark(oklch(50% 0.17 var(--hue)), oklch(71% 0.15 var(--hue)));
    --on-accent: oklch(99% 0.01 80);
    --success: light-dark(oklch(52% 0.13 150), oklch(76% 0.14 150));
    --warning: light-dark(oklch(58% 0.13 70), oklch(80% 0.13 80));
    --danger: light-dark(oklch(53% 0.2 27), oklch(70% 0.17 27));

    --font:
      system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, "Noto Sans", Ubuntu,
      Cantarell, sans-serif;
    --mono:
      ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas,
      "Liberation Mono", monospace;
    --radius: 0.5rem;
    --radius-l: 0.75rem;
    --shadow: 0 1px 2px oklch(0% 0 0 / 5%), 0 4px 16px oklch(0% 0 0 / 6%);
    --content: 60rem;
  }

  @media (forced-colors: active) {
    :root {
      --bg: Canvas;
      --bg-subtle: Canvas;
      --surface: Canvas;
      --hover: Canvas;
      --border: CanvasText;
      --border-strong: CanvasText;
      --text: CanvasText;
      --text-2: CanvasText;
      --text-3: CanvasText;
      --primary: ButtonText;
      --primary-ink: ButtonFace;
      --accent: LinkText;
      --on-accent: Canvas;
      --success: CanvasText;
      --warning: CanvasText;
      --danger: Mark;
    }
  }
}

@layer base {
  html {
    background: var(--bg);
    -webkit-text-size-adjust: 100%;
  }

  body {
    min-block-size: 100dvh;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 0.875rem;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    accent-color: var(--accent);
  }

  h1,
  h2,
  h3 {
    font-size: 1rem;
    font-weight: 620;
    letter-spacing: -0.015em;
    line-height: 1.2;
    text-wrap: balance;
  }

  h1 {
    font-size: 1.5rem;
  }

  p,
  li,
  dd {
    text-wrap: pretty;
  }

  a {
    color: inherit;
    text-underline-offset: 0.2em;
  }

  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  bdi[dir="ltr"] {
    unicode-bidi: isolate;
  }

  input:not([type="checkbox"], [type="radio"], [type="hidden"]),
  select,
  textarea {
    inline-size: 100%;
    min-block-size: 2.25rem;
    padding: 0.375rem 0.75rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: inset 0 1px 1px oklch(0% 0 0 / 3%);
    transition: border-color 120ms ease;

    &:hover {
      border-color: color-mix(in oklch, var(--border-strong) 60%, var(--text));
    }

    &:focus-visible {
      border-color: var(--accent);
      outline-offset: 0;
    }

    &:user-invalid,
    &[aria-invalid="true"] {
      border-color: var(--danger);
    }

    &:disabled,
    &[readonly] {
      color: var(--text-2);
      background: var(--bg-subtle);
    }
  }

  input[type="checkbox"],
  input[type="radio"] {
    inline-size: 1rem;
    block-size: 1rem;
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
    display: grid;
    gap: 0.875rem;
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  details > summary {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--text-3);
    font-size: 0.8125rem;
    cursor: pointer;
    list-style: none;

    &::-webkit-details-marker {
      display: none;
    }

    &::after {
      content: "";
      inline-size: 0.4rem;
      block-size: 0.4rem;
      border: solid currentColor;
      border-width: 0 1.5px 1.5px 0;
      rotate: 45deg;
      translate: 0 -0.1rem;
      transition: rotate 150ms ease;
    }

    &:hover {
      color: var(--text);
    }
  }

  details[open] > summary::after {
    rotate: 225deg;
    translate: 0 0.1rem;
  }

  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  [hidden] {
    display: none !important;
  }

  [popover] {
    inline-size: min(100% - 2rem, 25rem);
    padding: 1.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-l);
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 24px 64px -12px oklch(0% 0 0 / 35%);
    opacity: 0;
    scale: 0.97;
    transition:
      opacity 160ms ease,
      scale 160ms ease,
      overlay 160ms allow-discrete,
      display 160ms allow-discrete;

    &:popover-open {
      display: grid;
      gap: 0.5rem;
      opacity: 1;
      scale: 1;

      @starting-style {
        opacity: 0;
        scale: 0.97;
      }
    }

    &::backdrop {
      background: oklch(0% 0 0 / 30%);
      backdrop-filter: blur(2px);
    }

    p {
      color: var(--text-2);
    }

    form {
      justify-content: flex-end;
      margin-block-start: 0.75rem;
    }
  }
}

@layer layout {
  /* The console: a sidebar beside the content, which becomes a top bar when narrow. */
  .console {
    display: grid;
    grid-template-columns: 16rem minmax(0, 1fr);

    > main {
      container: content / inline-size;
      display: flex;
      flex-direction: column;
      min-inline-size: 0;
    }
  }

  .sidebar {
    position: sticky;
    inset-block-start: 0;
    align-self: start;
    block-size: 100dvh;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1.25rem 1rem;
    background: var(--bg-subtle);
    overflow: auto;
    view-transition-name: sidebar;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding-inline: 0.375rem;
    font-size: 0.9375rem;
    font-weight: 650;
    letter-spacing: -0.01em;
    text-decoration: none;
  }

  .logo {
    inline-size: 1.5rem;
    block-size: 1.5rem;
    flex: none;

    circle {
      fill: var(--accent);
    }

    rect {
      fill: var(--on-accent);
    }

    path {
      fill: var(--accent);
      opacity: 0.55;
    }
  }

  .nav a,
  .compose {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-block-size: 2.25rem;
    padding-inline: 0.625rem;
    border-radius: var(--radius);
    color: var(--text-2);
    font-weight: 500;
    text-decoration: none;

    &:hover {
      background: var(--hover);
      color: var(--text);
    }
  }

  /* The section the page belongs to gets stronger text; the page itself a soft fill. */
  .nav {
    display: grid;
    gap: 2px;

    a[aria-current="true"] {
      color: var(--text);
    }

    a[aria-current="page"] {
      background: var(--hover);
      color: var(--text);
    }
  }

  /* Write: a nav-style row marked by an accent pen rather than a filled button. */
  .compose {
    color: var(--text);
    font-weight: 560;

    .icon {
      color: var(--accent);
    }
  }

  .subnav {
    display: grid;
    gap: 2px;
    margin: 0.125rem 0 0.5rem;
    padding: 0 0 0 1.625rem;
    list-style: none;

    .mono {
      font-family: inherit;
      font-size: inherit;
    }

    a {
      display: block;
      align-content: center;
      min-block-size: 2rem;
      font-size: 0.8125rem;
      font-weight: 450;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .sidebar-foot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-block-start: auto;
    padding-inline: 0.625rem 0;
    color: var(--text-3);
    font-size: 0.8125rem;

    span:not(.sr-only) {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  /* Back link or breadcrumbs first, then the actions on the right. A hairline shows once the page
     scrolls, where scroll-driven animations exist. */
  .toolbar {
    position: sticky;
    inset-block-start: 0;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 3.5rem;
    padding: 0.75rem max(2.5rem, 100cqi - var(--content) + 2.5rem) 0.75rem 2.5rem;
    background: color-mix(in oklch, var(--bg) 82%, transparent);
    backdrop-filter: blur(14px) saturate(1.4);
    border-block-end: 1px solid transparent;

    > :first-child {
      margin-inline-end: auto;
    }

    @supports (animation-timeline: scroll()) {
      animation: edge linear both;
      animation-timeline: scroll(root);
      animation-range: 0 3rem;
    }
  }

  @keyframes edge {
    to {
      border-block-end-color: var(--border);
    }
  }

  .content {
    display: grid;
    gap: 2rem;
    align-content: start;
    inline-size: min(100%, var(--content));
    padding: 2rem 2.5rem 3rem;
  }

  .page-head {
    display: grid;
    gap: 0.5rem;
  }

  .lede {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-2);
  }

  @media (width < 52rem) {
    .console {
      grid-template-columns: minmax(0, 1fr);
    }

    .sidebar {
      position: static;
      block-size: auto;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.75rem;
    }

    .brand {
      margin-inline-end: auto;
    }

    .sidebar-foot {
      order: 1;
      margin: 0;
      padding: 0;

      span:not(.sr-only) {
        display: none;
      }
    }

    .nav {
      order: 2;
      flex-basis: 100%;
      display: flex;
      gap: 0.25rem;
      overflow-x: auto;

      > a {
        flex: none;
      }
    }

    .subnav {
      display: flex;
      gap: 0.25rem;
      margin: 0;
      padding: 0;

      a {
        border-radius: 999px;
        padding-inline: 0.75rem;
      }
    }

    .toolbar {
      position: static;
      padding-inline: 1rem;
    }

    .content {
      padding: 1.25rem 1rem 2rem;
    }
  }

  /* Sign-in, consent, device and notices: a centred card. Approval: one column under a brand bar. */
  .focus {
    display: flex;
    flex-direction: column;
    background: var(--bg-subtle);

    > main {
      container: content / inline-size;
      flex: 1;
      display: grid;
      place-items: center;
      padding: 1.5rem 1rem 4rem;
    }
  }

  .card {
    display: grid;
    gap: 1.25rem;
    inline-size: min(100%, 24rem);
    padding: 1.75rem;
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    background: var(--surface);
    box-shadow: var(--shadow);

    > header {
      display: grid;
      gap: 0.75rem;
      justify-items: start;
    }

    .logo {
      inline-size: 2.25rem;
      block-size: 2.25rem;
    }

    h1 {
      font-size: 1.25rem;
    }
  }

  .card:has(.meta) {
    inline-size: min(100%, 36rem);
  }

  .focus-bar {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.875rem 1.25rem;
    font-size: 0.9375rem;
    font-weight: 650;
    letter-spacing: -0.01em;

    small {
      margin-inline-start: auto;
      color: var(--text-3);
      font-size: 0.8125rem;
      font-weight: 450;
      letter-spacing: normal;
    }
  }

  .focus > .column {
    display: grid;
    place-items: stretch;
    gap: 1.25rem;
    align-content: start;
    inline-size: min(100%, 44rem);
    margin-inline: auto;
    padding: 0.5rem 1rem 4rem;

    h1 {
      font-size: 1.625rem;
    }
  }
}

@layer components {
  .icon {
    inline-size: 1rem;
    block-size: 1rem;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .mono {
    font-family: var(--mono);
    font-size: 0.92em;
  }

  .muted {
    color: var(--text-2);
  }

  .stack {
    display: grid;
    gap: 1rem;
    align-content: start;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  /* Ink-coloured primary; secondary is a soft fill; quiet and danger are text until hovered. */
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4375rem;
    min-block-size: 2.25rem;
    padding: 0 0.875rem;
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: var(--primary);
    color: var(--primary-ink);
    font-weight: 560;
    line-height: 1;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color 120ms ease,
      color 120ms ease;

    &:hover {
      background: color-mix(in oklch, var(--primary) 86%, var(--bg));
    }

    &:disabled {
      cursor: wait;
      opacity: 0.6;
    }

    &.secondary {
      background: var(--hover);
      color: var(--text);

      &:hover {
        background: color-mix(in oklch, var(--hover), var(--text) 7%);
      }
    }

    &.quiet {
      background: transparent;
      color: var(--text-2);

      &:hover {
        background: var(--hover);
        color: var(--text);
      }
    }

    &.danger {
      background: transparent;
      color: var(--danger);

      &:hover {
        background: color-mix(in oklch, var(--danger) 9%, transparent);
      }
    }

    &.danger.solid {
      background: var(--danger);
      color: var(--on-accent);
    }

    &.icon-only {
      padding-inline: 0.5rem;
    }
  }

  .card .button {
    inline-size: 100%;
  }

  /* The focus pages keep 44px controls. */
  .focus :is(button, .button, input:not([type="checkbox"], [type="radio"]), select) {
    min-block-size: 2.75rem;
  }

  @container content (inline-size < 40rem) {
    .toolbar .label {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .toolbar .button:has(.label) {
      padding-inline: 0.625rem;
    }
  }

  .field {
    display: grid;
    gap: 0.375rem;

    > label {
      font-weight: 560;
    }
  }

  .hint {
    color: var(--text-3);
    font-size: 0.8125rem;
  }

  .error {
    color: var(--danger);
    font-size: 0.8125rem;
    font-weight: 560;
  }

  /* An input joined to its domain. */
  .suffixed {
    display: flex;

    > input {
      min-inline-size: 0;
      border-start-end-radius: 0;
      border-end-end-radius: 0;
    }

    > span {
      display: flex;
      align-items: center;
      padding-inline: 0.75rem;
      border: 1px solid var(--border-strong);
      border-inline-start: 0;
      border-start-end-radius: var(--radius);
      border-end-end-radius: var(--radius);
      background: var(--hover);
      color: var(--text-2);
      white-space: nowrap;
    }
  }

  /* A radio as a card; the whole card is the label. */
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr));
    gap: 0.5rem;
  }

  .choice {
    position: relative;
    display: grid;
    align-content: start;
    gap: 0.125rem;
    padding: 0.75rem 0.875rem 0.75rem 2.375rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    cursor: pointer;
    transition:
      border-color 120ms ease,
      background-color 120ms ease;

    input {
      position: absolute;
      inset-inline-start: 0.875rem;
      inset-block-start: 0.875rem;
    }

    b {
      font-weight: 560;
    }

    small {
      color: var(--text-3);
      font-size: 0.8125rem;
    }

    &:hover {
      border-color: var(--border-strong);
    }

    &:has(input:checked) {
      border-color: var(--accent);
      background: color-mix(in oklch, var(--accent) 5%, var(--surface));
      box-shadow: 0 0 0 1px var(--accent);
    }

    &:has(input:focus-visible) {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
  }

  /* A fieldset shows its .revealed part only while the choice marked data-reveal is checked. */
  fieldset:not(:has(input[data-reveal]:checked)) .revealed {
    display: none;
  }

  .checklist {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);

    li + li {
      border-block-start: 1px solid var(--border);
    }

    label {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      min-block-size: 2.5rem;
      padding-inline: 0.875rem;
      overflow-wrap: anywhere;
      cursor: pointer;
    }
  }

  /* The switch: a plain checkbox, restyled. */
  .switch-row {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    cursor: pointer;

    > span {
      display: grid;
    }

    b {
      font-weight: 560;
    }

    small {
      color: var(--text-3);
      font-size: 0.8125rem;
    }
  }

  input.switch {
    appearance: none;
    position: relative;
    inline-size: 2.125rem;
    block-size: 1.25rem;
    border-radius: 999px;
    background: var(--border-strong);
    cursor: pointer;
    transition: background-color 150ms ease;

    &::before {
      content: "";
      position: absolute;
      inset: 0.125rem;
      inline-size: 1rem;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px oklch(0% 0 0 / 25%);
      transition: translate 150ms ease;
    }

    &:checked {
      background: var(--accent);

      &::before {
        translate: 0.875rem 0;
      }
    }
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-block-size: 1.375rem;
    padding: 0 0.5rem;
    border-radius: 999px;
    background: var(--hover);
    color: var(--text-2);
    font-size: 0.75rem;
    font-weight: 560;
    white-space: nowrap;

    &::before {
      content: "";
      inline-size: 0.375rem;
      block-size: 0.375rem;
      border-radius: 50%;
      background: currentColor;
    }

    &.accent {
      background: color-mix(in oklch, var(--accent) 12%, transparent);
      color: var(--accent);
    }

    &.success {
      background: color-mix(in oklch, var(--success) 13%, transparent);
      color: var(--success);
    }

    &.warning {
      background: color-mix(in oklch, var(--warning) 15%, transparent);
      color: var(--warning);
    }

    &.danger {
      background: color-mix(in oklch, var(--danger) 12%, transparent);
      color: var(--danger);
    }
  }

  .chip {
    display: inline-block;
    padding: 0.0625rem 0.375rem;
    border-radius: 0.3125rem;
    background: var(--hover);
    color: var(--text-2);
    font-family: var(--mono);
    font-size: 0.6875rem;
    white-space: nowrap;
  }

  .note,
  .flash {
    display: flex;
    align-items: start;
    gap: 0.625rem;
    padding: 0.625rem 0.75rem;
    border-radius: var(--radius);
    background: var(--hover);
    color: var(--text-2);
    font-size: 0.8125rem;

    .icon {
      margin-block-start: 0.125rem;
    }
  }

  .note.warning {
    background: color-mix(in oklch, var(--warning) 11%, var(--bg));
    color: color-mix(in oklch, var(--warning) 55%, var(--text));
  }

  .flash {
    background: color-mix(in oklch, var(--danger) 10%, var(--bg));
    color: color-mix(in oklch, var(--danger) 65%, var(--text));
    font-size: 0.875rem;
  }

  /* A success message: fades out on its own, and never blocks what lies under it. */
  .toast {
    position: sticky;
    inset-block-end: 1rem;
    z-index: 3;
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin: auto 1rem 1rem;
    padding: 0.5rem 0.875rem 0.5rem 0.625rem;
    border-radius: 999px;
    background: var(--primary);
    color: var(--primary-ink);
    font-weight: 540;
    box-shadow: var(--shadow);
    pointer-events: none;
    animation: toast 4.5s ease both;

    .icon {
      color: var(--success);
    }
  }

  @keyframes toast {
    0% {
      opacity: 0;
      translate: 0 0.75rem;
    }

    6%,
    85% {
      opacity: 1;
      translate: 0 0;
    }

    100% {
      opacity: 0;
      translate: 0 0.25rem;
    }
  }

  @keyframes toast-fade {
    0%,
    100% {
      opacity: 0;
    }

    6%,
    85% {
      opacity: 1;
    }
  }

  .status {
    min-block-size: 1.25rem;
    color: var(--text-3);
    font-size: 0.8125rem;

    &[data-kind="error"] {
      color: var(--danger);
    }

    &[data-kind="success"] {
      color: var(--success);
    }
  }

  .empty {
    padding: 3rem 1rem;
    color: var(--text-3);
    text-align: center;
  }

  /* The mail list: one grid whose rows share columns through subgrid. The edge tracks are empty so
     the row's hover fill reaches past the text, which lines up with the heading. */
  .threads {
    display: grid;
    grid-template-columns: 0 0.5rem minmax(7rem, 12rem) minmax(0, 1fr) auto 0;
    column-gap: 0.875rem;
    margin: 0 -0.875rem;
    padding: 0;
    list-style: none;

    > li {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: subgrid;
    }
  }

  .thread {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: subgrid;
    align-items: center;
    padding-block: 0.8125rem;
    border-radius: 0.625rem;
    text-decoration: none;

    &:hover {
      background: var(--hover);
    }

    .dot {
      grid-column: 2;
      inline-size: 0.5rem;
      block-size: 0.5rem;
      border-radius: 50%;
    }

    .who {
      display: flex;
      align-items: baseline;
      gap: 0.375rem;
      min-inline-size: 0;

      b {
        font-weight: 450;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      small {
        color: var(--text-3);
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
      }
    }

    .what {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-inline-size: 0;
      color: var(--text-2);

      > bdi {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    time {
      color: var(--text-3);
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;
      text-align: end;
      white-space: nowrap;
    }
  }

  .thread.unread {
    .dot {
      background: var(--accent);
    }

    .who b {
      font-weight: 640;
    }

    .what > bdi,
    time {
      color: var(--text);
      font-weight: 560;
    }
  }

  @container content (inline-size < 40rem) {
    .threads,
    .threads > li {
      display: block;
    }

    .threads {
      margin-inline: -0.75rem;
    }

    .thread {
      grid-template-columns: 0.5rem minmax(0, 1fr) auto;
      gap: 0.25rem 0.75rem;
      padding-inline: 0.75rem;

      .dot {
        grid-column: auto;
      }

      .what {
        grid-column: 2 / -1;
      }

      time {
        grid-area: 1 / 3;
      }
    }
  }

  .pager {
    display: flex;
    justify-content: flex-end;
  }

  /* Mailbox and client lists: rounded rows that fill on hover, a name line and a muted line. */
  .rows {
    display: grid;
    gap: 2px;
    margin: 0 -0.875rem;
    padding: 0;
    list-style: none;
  }

  .row {
    display: grid;
    gap: 0.125rem;
    padding: 0.75rem 0.875rem;
    border-radius: 0.625rem;
    text-decoration: none;
    overflow-wrap: anywhere;

    &:hover {
      background: var(--hover);
    }

    > span {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.625rem;
      font-weight: 560;
    }

    > small {
      color: var(--text-3);
      font-size: 0.8125rem;
    }
  }

  .crumbs {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-inline-size: 0;
    color: var(--text-3);

    a {
      color: var(--text-2);
      text-decoration: none;

      &:hover {
        color: var(--text);
      }
    }

    > span {
      color: var(--text);
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  /* A conversation: earlier messages as one-line rows on one sheet, the open one in full. */
  .messages {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-l);
    background: var(--surface);
    overflow: hidden;

    > li + li {
      border-block-start: 1px solid var(--border);
    }
  }

  .avatar {
    display: grid;
    place-items: center;
    inline-size: 2rem;
    block-size: 2rem;
    flex: none;
    border-radius: 50%;
    background: var(--hover);
    color: var(--text-2);
    font-size: 0.75rem;
    font-weight: 620;
  }

  .message-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1.25rem;
    color: var(--text-2);
    text-decoration: none;

    &:hover {
      background: var(--hover);
    }

    b {
      color: var(--text);
      font-weight: 560;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    time {
      color: var(--text-3);
      font-size: 0.8125rem;
    }
  }

  .message {
    display: grid;
    gap: 1.25rem;
    padding: 1.25rem;
  }

  .message-head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.75rem;

    > div {
      display: grid;
      gap: 0.0625rem;
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }

    b {
      font-weight: 620;
    }

    small {
      color: var(--text-2);
      font-size: 0.8125rem;
    }

    time {
      color: var(--text-3);
      font-size: 0.8125rem;
      white-space: nowrap;
    }
  }

  @container content (inline-size < 30rem) {
    .message-head {
      grid-template-columns: auto minmax(0, 1fr);

      time {
        grid-column: 2;
      }
    }
  }

  .more {
    &::details-content {
      block-size: 0;
      overflow: clip;
      transition:
        block-size 200ms ease,
        content-visibility 200ms allow-discrete;
    }

    &[open]::details-content {
      block-size: auto;
    }
  }

  .meta {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.375rem 1.25rem;
    padding-block: 0.75rem 0.25rem;
    font-size: 0.8125rem;

    dt {
      color: var(--text-3);
    }

    dd {
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }
  }

  :is(.meta, .compose-row) ul {
    display: grid;
    gap: 0.125rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  @container content (inline-size < 30rem) {
    .meta {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;

      dd {
        margin-block-end: 0.5rem;
      }
    }
  }

  /* Emails assume a white page, so the body frame stays white in both themes. */
  .frame {
    inline-size: 100%;
    block-size: min(80dvh, 60rem);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: white;
  }

  .prose {
    max-block-size: 40rem;
    overflow: auto;
    padding: 1rem 1.25rem;
    border-radius: var(--radius);
    background: var(--surface);
    font-family: var(--font);
  }

  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;

    a {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      max-inline-size: 100%;
      padding: 0.5rem 0.75rem;
      border-radius: var(--radius);
      background: var(--hover);
      text-decoration: none;

      &:hover {
        background: color-mix(in oklch, var(--hover), var(--text) 7%);
      }

      bdi {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      small {
        color: var(--text-3);
      }
    }
  }

  /* Compose: one sheet, the fields as hairline rows like a mail client. */
  .composer {
    border: 1px solid var(--border);
    border-radius: var(--radius-l);
    background: var(--surface);
    box-shadow: 0 1px 2px oklch(0% 0 0 / 4%);
    overflow: hidden;

    :focus-visible {
      outline-offset: -2px;
    }

    > .error {
      padding: 0 1rem 0.5rem;
    }

    textarea {
      display: block;
      min-block-size: 16rem;
      padding: 1rem;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      font-size: 0.9375rem;
      line-height: 1.6;
    }
  }

  .compose-row {
    display: grid;
    grid-template-columns: 4.5rem minmax(0, 1fr);
    align-items: center;
    min-block-size: 2.75rem;
    padding-inline: 1rem;
    border-block-end: 1px solid var(--border);

    > :first-child {
      color: var(--text-3);
    }

    > :is(input, select) {
      min-block-size: 2.75rem;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
    }

    > ul {
      padding-block: 0.5rem;
    }

    > .error {
      grid-column: 2;
      padding-block-end: 0.5rem;
    }

    &:focus-within {
      background: color-mix(in oklch, var(--hover) 50%, transparent);
    }
  }

  .composer-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    border-block-start: 1px solid var(--border);
    background: var(--bg-subtle);

    small {
      margin-inline-start: auto;
    }
  }

  /* Settings: the label column beside the controls, stacked when narrow. */
  .settings {
    container: settings / inline-size;
    display: grid;
  }

  .setting {
    display: grid;
    grid-template-columns: 13rem minmax(0, 1fr);
    gap: 1rem 3rem;
    padding-block: 1.75rem;

    > header {
      display: grid;
      gap: 0.25rem;
      align-content: start;

      h2 {
        font-size: 0.9375rem;
      }

      p {
        color: var(--text-3);
        font-size: 0.8125rem;
      }
    }

    > :not(header) {
      display: grid;
      gap: 0.875rem;
      align-content: start;
      min-inline-size: 0;
    }
  }

  @container settings (inline-size < 40rem) {
    .setting {
      grid-template-columns: minmax(0, 1fr);
      padding-block: 1rem;
    }
  }

  .danger-zone {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem 1.5rem;
    padding: 1rem;
    border: 1px solid color-mix(in oklch, var(--danger) 28%, var(--border));
    border-radius: var(--radius-l);

    > div {
      display: grid;
      gap: 0.125rem;
      max-inline-size: 42ch;
    }

    b {
      font-weight: 600;
    }

    p {
      color: var(--text-3);
      font-size: 0.8125rem;
    }
  }

  /* Approval: the request as one summary card, then the body, then the decision. */
  .summary {
    display: grid;
    gap: 1rem;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-l);
    background: var(--surface);

    > p {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      color: var(--text-3);
      font-size: 0.8125rem;
    }

    .who {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      color: var(--text-2);

      b {
        color: var(--text);
        font-weight: 600;
      }
    }

    h2 {
      font-size: 1.0625rem;
      overflow-wrap: anywhere;
    }

    .meta {
      padding: 0;
    }
  }

  .section-label {
    color: var(--text-3);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .decision {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1rem;
    padding-block-start: 0.5rem;

    p {
      flex: 1 1 16rem;
      color: var(--text-2);
    }
  }

  /* The device code, to compare against the terminal. */
  .code {
    font-family: var(--mono);
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    overflow-wrap: anywhere;
  }
}

/* Reduced motion keeps the fades, since the toast must still disappear, and drops movement. */
@media (prefers-reduced-motion: reduce) {
  @view-transition {
    navigation: none;
  }

  @layer components {
    .toast {
      animation-name: toast-fade;
    }

    .more::details-content {
      transition: none;
    }
  }

  @layer base {
    [popover],
    details > summary::after {
      transition-property: opacity, overlay, display;
    }
  }
}
`;
