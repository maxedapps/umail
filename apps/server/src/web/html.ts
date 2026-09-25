import type { MailContact } from "@umail/api-contract";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

// Markup the `html` template produced, or trusted markup from `trustedHtml`. Nothing else can make one,
// so every other value that reaches a page is escaped.
const HtmlText = Symbol("umail/web/Html");

export type Html = { readonly [HtmlText]: string };

export type HtmlValue =
  | Html
  | string
  | number
  | false
  | null
  | undefined
  | ReadonlyArray<HtmlValue>;

// Escapes every interpolated value unless it is already `Html`. `false`, `null` and `undefined`
// render nothing, so conditionals can be written inline.
export function html(strings: TemplateStringsArray, ...values: ReadonlyArray<HtmlValue>): Html {
  let text = strings[0] ?? "";
  for (const [index, value] of values.entries()) {
    text += render(value) + (strings[index + 1] ?? "");
  }
  return { [HtmlText]: text };
}

function render(value: HtmlValue): string {
  if (value === false || value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value).replace(/[&<>"']/gu, escapeCharacter);
  }
  if (HtmlText in value) return value[HtmlText];
  return value.map(render).join("");
}

function escapeCharacter(character: string): string {
  switch (character) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case '"':
      return "&quot;";
    default:
      return "&#39;";
  }
}

export function htmlText(value: Html): string {
  return value[HtmlText];
}

// Markup the server wrote or sanitized itself: the stylesheet, a page script, a stored mail body.
// Only the document renderer uses it.
export function trustedHtml(text: string): Html {
  return { [HtmlText]: text };
}

// Mail metadata is attacker-controlled: bidi controls could reorder what the operator reads, and
// line breaks could fake extra rows. Both are removed or made visible before display.
export function displayText(value: string): string {
  let projection = "";
  let previousWasLineSeparator = false;
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (isBidiControl(codePoint)) continue;
    if (isLineSeparator(codePoint)) {
      if (!previousWasLineSeparator) projection += " ⏎ ";
      previousWasLineSeparator = true;
      continue;
    }
    previousWasLineSeparator = false;
    projection += isOtherControlCharacter(codePoint) ? " " : character;
  }
  return projection.replace(/\s+/gu, " ").trim();
}

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function isLineSeparator(codePoint: number): boolean {
  return codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x2028 || codePoint === 0x2029;
}

function isOtherControlCharacter(codePoint: number): boolean {
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0b && codePoint <= 0x0c) ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

export function bidiText(value: string): Html {
  return html`<bdi dir="auto">${displayText(value)}</bdi>`;
}

export function bidiAddress(value: string): Html {
  return html`<bdi dir="ltr">${displayText(value)}</bdi>`;
}

export function contactHtml(contact: MailContact): Html {
  const address = bidiAddress(contact.address);
  if (contact.displayName === null || contact.displayName.length === 0) return address;
  return html`<span class="contact"
    >${bidiText(contact.displayName)} <span aria-hidden="true">&lt;</span>${address}<span
      aria-hidden="true"
      >&gt;</span
    ></span
  >`;
}

export function contactListHtml(contacts: ReadonlyArray<MailContact>): Html {
  return contacts.length === 0
    ? html`<span class="muted">Nobody</span>`
    : html`<ul>
        ${contacts.map((contact) => html`<li>${contactHtml(contact)}</li>`)}
      </ul>`;
}

export function contactName(contact: MailContact): string {
  return contact.displayName === null || contact.displayName.length === 0
    ? contact.address
    : contact.displayName;
}

// An avatar's letters: the first letter or digit of up to two words, "?" when there are none.
export function initials(name: string): string {
  const letters = displayText(name)
    .split(" ")
    .flatMap((word) => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? [])
    .slice(0, 2);
  return letters.length === 0 ? "?" : letters.join("").toUpperCase();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "24 Sep 2026, 08:00 UTC": the text every `<time>` carries until the console script shows it in
// the viewer's zone. Built by hand so Node and workerd print the same.
export function utcDateTime(iso: string): string {
  const parsed = DateTime.make(iso);
  if (Option.isNone(parsed)) return iso;
  const parts = DateTime.toPartsUtc(parsed.value);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}, ${pad(parts.hour)}:${pad(parts.minute)} UTC`;
}

export function timeHtml(iso: string): Html {
  return html`<time datetime="${iso}">${utcDateTime(iso)}</time>`;
}

// A list time: the console script shortens it to the time today, the day this year, else the date.
export function shortTimeHtml(iso: string): Html {
  return html`<time datetime="${iso}" data-short>${utcDateTime(iso)}</time>`;
}
