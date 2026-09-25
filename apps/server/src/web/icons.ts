import { html, type Html } from "./html.ts";

// Inline SVG, since the page CSP blocks images and fonts. Stroke and fill come from `.icon` in the
// stylesheet; every icon sits next to a visible or screen-reader label, so it is hidden from both.
const PATHS = {
  inbox: html`<path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path
      d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
    />`,
  pen: html`<path d="M12 20h9" /> <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />`,
  at: html`<circle cx="12" cy="12" r="4" /> <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />`,
  key: html`<circle cx="7.5" cy="15.5" r="5.5" />
    <path d="m21 2-9.6 9.6" />
    <path d="m15.5 7.5 3 3L22 7l-3-3" />`,
  logout: html`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />`,
  reply: html`<path d="m9 17-5-5 5-5" /> <path d="M20 18v-2a4 4 0 0 0-4-4H4" />`,
  "reply-all": html`<path d="m7 17-5-5 5-5" />
    <path d="m12 17-5-5 5-5" />
    <path d="M22 18v-2a4 4 0 0 0-4-4H7" />`,
  mail: html`<rect width="20" height="16" x="2" y="4" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />`,
  trash: html`<path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />`,
  clip: html`<path
    d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
  />`,
  send: html`<path d="m22 2-7 20-4-9-9-4Z" /> <path d="M22 2 11 13" />`,
  left: html`<path d="m15 18-6-6 6-6" />`,
  right: html`<path d="m9 18 6-6-6-6" />`,
  clock: html`<circle cx="12" cy="12" r="10" /> <path d="M12 6v6l4 2" />`,
  "eye-off": html`<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <path d="m2 2 20 20" />`,
  alert: html`<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />`,
  check: html`<circle cx="12" cy="12" r="10" /> <path d="m9 12 2 2 4-4" />`,
} satisfies Record<string, Html>;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): Html {
  return html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    ${PATHS[name]}
  </svg>`;
}

// The brand mark: an envelope on an accent disc, coloured by `.logo` in the stylesheet.
export const logo: Html = html`<svg
  class="logo"
  viewBox="0 0 32 32"
  aria-hidden="true"
  focusable="false"
>
  <circle cx="16" cy="16" r="16" />
  <rect x="8.5" y="11.5" width="15" height="10" rx="1.6" />
  <path d="M9.5 12.2 16 16.6l6.5-4.4z" />
</svg>`;
