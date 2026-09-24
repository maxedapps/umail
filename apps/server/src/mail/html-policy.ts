import type { CssNode, Declaration, Value } from "css-tree";
import generate from "css-tree/generator";
import parse from "css-tree/parser";
import type { Element, ElementContent, Properties, Root, RootContent } from "hast";
import { fromParse5 } from "hast-util-from-parse5";
import { toHtml } from "hast-util-to-html";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MailHtmlResourceExhaustion, parseBoundedMailHtmlFragment } from "./html-parser.ts";

export type MailHtmlAttachment = {
  readonly id: string;
  readonly contentId: string | null;
  readonly mimeType: string;
};

export type MailHtmlSanitization = {
  readonly messageId: string;
  readonly attachments: ReadonlyArray<MailHtmlAttachment>;
};

export type MailHtmlMaterialization = {
  readonly body: string;
  readonly applicationUrl: URL;
};

export type StoredMailHtml = {
  readonly body: string;
  readonly hasRemoteImages: boolean;
};

export class MailHtmlPolicyError extends Schema.TaggedError<MailHtmlPolicyError>()(
  "MailHtmlPolicyError",
  {
    reason: Schema.Union([Schema.Literal("resource_exhausted"), Schema.Literal("rewrite_failed")]),
  },
) {}

export interface MailHtmlPolicy {
  sanitizeForStorage(
    html: string,
    sanitization: MailHtmlSanitization,
  ): Effect.Effect<StoredMailHtml, MailHtmlPolicyError>;
  materializeRemoteImages(
    materialization: MailHtmlMaterialization,
  ): Effect.Effect<string, MailHtmlPolicyError>;
}

const MAX_INLINE_STYLE_BYTES = 8 * 1024;
const REMOTE_SOURCE_PROPERTY = "dataUmailRemoteSrc";
const LINK_REL_TOKENS = ["noopener", "noreferrer", "nofollow"] as const;

// `store` sanitizes untrusted input; `activate` re-sanitizes stored HTML and turns its inert
// remote-image metadata into live cross-origin sources.
type MailHtmlCleanContext =
  | {
      readonly mode: "store";
      readonly messageId: string;
      readonly cidResolutions: ReadonlyMap<string, CidResolution>;
      hasRemoteImages: boolean;
    }
  | { readonly mode: "activate"; readonly applicationOrigin: string };

// Kept, with only the attributes allowed below.
const ALLOWED_ELEMENTS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "nobr",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
]);

// Removed with their content: raw-text and RCDATA elements (their text would surface as literal
// code), foreign SVG/MathML content, and inert template content. Every other element is
// unwrapped, so its content survives (for example `font`, `form`, or Outlook's `o:p`).
const DROPPED_ELEMENTS = new Set([
  "iframe",
  "math",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "xmp",
]);

const GLOBAL_PROPERTIES = new Set(["ariaHidden", "ariaLabel", "dir", "lang", "role", "title"]);

const ELEMENT_PROPERTIES = new Map<string, ReadonlySet<string>>([
  ["img", new Set(["alt", "height", "width"])],
  ["li", new Set(["value"])],
  ["ol", new Set(["reversed", "start", "type"])],
  ["td", new Set(["colSpan", "headers", "rowSpan"])],
  ["th", new Set(["colSpan", "headers", "rowSpan", "scope"])],
  ["time", new Set(["dateTime"])],
]);

const SAFE_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

const COLOR_PROPERTIES = new Set([
  "color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
]);
const LENGTH_PROPERTIES = new Set([
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-width",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "border-spacing",
  "font-size",
  "letter-spacing",
  "text-indent",
  "word-spacing",
]);
const BORDER_PROPERTIES = new Set([
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
]);
const BORDER_STYLES = new Set([
  "none",
  "hidden",
  "dotted",
  "dashed",
  "solid",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
]);
const IDENTIFIER_PROPERTIES = new Map<string, ReadonlySet<string>>([
  [
    "display",
    new Set([
      "block",
      "inline",
      "inline-block",
      "table",
      "inline-table",
      "table-row-group",
      "table-header-group",
      "table-footer-group",
      "table-row",
      "table-column-group",
      "table-column",
      "table-cell",
      "table-caption",
    ]),
  ],
  ["border-style", BORDER_STYLES],
  ["border-top-style", BORDER_STYLES],
  ["border-right-style", BORDER_STYLES],
  ["border-bottom-style", BORDER_STYLES],
  ["border-left-style", BORDER_STYLES],
  ["border-collapse", new Set(["collapse", "separate"])],
  ["table-layout", new Set(["auto", "fixed"])],
  ["font-style", new Set(["normal", "italic", "oblique"])],
  ["font-variant", new Set(["normal", "small-caps"])],
  ["text-align", new Set(["start", "end", "left", "right", "center", "justify", "match-parent"])],
  ["text-transform", new Set(["none", "capitalize", "uppercase", "lowercase"])],
  ["text-decoration-style", new Set(["solid", "double", "dotted", "dashed", "wavy"])],
  ["white-space", new Set(["normal", "pre", "nowrap", "pre-wrap", "pre-line", "break-spaces"])],
  ["word-break", new Set(["normal", "break-all", "keep-all", "break-word"])],
  ["overflow-wrap", new Set(["normal", "break-word", "anywhere"])],
]);

const COLOR_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla"]);
const COLOR_FUNCTION_OPERATORS = new Set([",", "/"]);
const COLOR_NAMES = new Set([
  "aqua",
  "black",
  "blue",
  "fuchsia",
  "gray",
  "green",
  "lime",
  "maroon",
  "navy",
  "olive",
  "purple",
  "red",
  "silver",
  "teal",
  "transparent",
  "white",
  "yellow",
]);
const BORDER_IDENTIFIERS = new Set([...BORDER_STYLES, "thin", "medium", "thick", ...COLOR_NAMES]);
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert"]);
const LENGTH_UNITS = new Set(["px", "em", "rem", "pt", "pc", "in", "cm", "mm", "q", "ch", "ex"]);
const FONT_WEIGHTS = new Set(["normal", "bold", "bolder", "lighter"]);
const TEXT_DECORATIONS = new Set(["none", "underline", "overline", "line-through"]);
const VERTICAL_ALIGNMENTS = new Set([
  "baseline",
  "sub",
  "super",
  "text-top",
  "text-bottom",
  "middle",
  "top",
  "bottom",
]);

type CidResolution =
  | { readonly kind: "valid"; readonly attachmentId: string }
  | { readonly kind: "invalid" };

export function createMailHtmlPolicy(): MailHtmlPolicy {
  return {
    sanitizeForStorage(html, sanitization) {
      return Effect.try({
        try: () => sanitizeHtmlForStorage(html, sanitization),
        catch: mailHtmlPolicyErrorFromCause,
      });
    },
    materializeRemoteImages({ body, applicationUrl }) {
      return Effect.try({
        try: () =>
          toHtml(
            cleanMailHtml(parseMailHtmlFragment(body), {
              mode: "activate",
              applicationOrigin: applicationUrl.origin,
            }),
          ),
        catch: mailHtmlPolicyErrorFromCause,
      });
    },
  };
}

function sanitizeHtmlForStorage(html: string, sanitization: MailHtmlSanitization): StoredMailHtml {
  const context: MailHtmlCleanContext = {
    mode: "store",
    messageId: sanitization.messageId,
    cidResolutions: cidMap(sanitization.attachments),
    hasRemoteImages: false,
  };
  const body = toHtml(cleanMailHtml(parseMailHtmlFragment(html), context));
  // Stored HTML is parsed again when it is materialized, so it must fit the same parse budgets.
  parseBoundedMailHtmlFragment(body);
  return { body, hasRemoteImages: context.hasRemoteImages };
}

function parseMailHtmlFragment(html: string): Root {
  const parsed = fromParse5(parseBoundedMailHtmlFragment(html));
  if (parsed.type !== "root") {
    throw new Error("parse5 fragment did not produce a root");
  }
  return parsed;
}

function mailHtmlPolicyErrorFromCause(cause: unknown): MailHtmlPolicyError {
  return new MailHtmlPolicyError({
    reason: Schema.is(MailHtmlResourceExhaustion)(cause) ? "resource_exhausted" : "rewrite_failed",
  });
}

function cleanMailHtml(tree: Root, context: MailHtmlCleanContext): Root {
  return { type: "root", children: cleanChildren(tree.children, context) };
}

function cleanChildren(
  children: ReadonlyArray<RootContent>,
  context: MailHtmlCleanContext,
): ElementContent[] {
  const result: ElementContent[] = [];
  for (const child of children) {
    if (child.type === "text") {
      result.push({ type: "text", value: child.value });
    } else if (child.type !== "element" || DROPPED_ELEMENTS.has(child.tagName)) {
      continue;
    } else if (ALLOWED_ELEMENTS.has(child.tagName)) {
      result.push(cleanElement(child, context));
    } else {
      for (const unwrapped of cleanChildren(child.children, context)) result.push(unwrapped);
    }
  }
  return result;
}

function cleanElement(element: Element, context: MailHtmlCleanContext): Element {
  const tagName = element.tagName;
  const properties: Properties = {};
  const elementProperties = ELEMENT_PROPERTIES.get(tagName);
  for (const name of Object.keys(element.properties)) {
    if (!GLOBAL_PROPERTIES.has(name) && elementProperties?.has(name) !== true) continue;
    const copied = copyAllowedProperty(name, element.properties[name]);
    if (copied !== undefined) properties[name] = copied;
  }
  const style = sanitizeInlineStyle(propertyText(element.properties.style));
  if (style !== null) properties.style = style;
  if (tagName === "a") cleanAnchor(properties, propertyText(element.properties.href));
  if (tagName === "img") cleanImage(properties, element.properties, context);
  return {
    type: "element",
    tagName,
    properties,
    children: cleanChildren(element.children, context),
  };
}

function cleanAnchor(properties: Properties, href: string | null): void {
  const url = canonicalHttpsUrl(href);
  if (url === null) return;
  properties.href = url.href;
  properties.target = "_blank";
  properties.rel = [...LINK_REL_TOKENS];
  properties.referrerPolicy = "no-referrer";
}

function cleanImage(
  properties: Properties,
  source: Properties,
  context: MailHtmlCleanContext,
): void {
  if (context.mode === "activate") {
    const remote = canonicalHttpsUrl(propertyText(source[REMOTE_SOURCE_PROPERTY]));
    if (remote === null) return;
    properties[REMOTE_SOURCE_PROPERTY] = remote.href;
    if (remote.origin === context.applicationOrigin) return;
    properties.src = remote.href;
    properties.referrerPolicy = "no-referrer";
    return;
  }
  const src = propertyText(source.src)?.trim();
  if (src === undefined) return;
  if (src.toLowerCase().startsWith("cid:")) {
    const resolution = context.cidResolutions.get(normalizeCid(src.slice(4)));
    if (resolution?.kind !== "valid") return;
    properties.src = `/messages/${encodeURIComponent(context.messageId)}/attachments/${encodeURIComponent(resolution.attachmentId)}`;
    return;
  }
  const remote = canonicalHttpsUrl(src);
  if (remote === null) return;
  properties[REMOTE_SOURCE_PROPERTY] = remote.href;
  context.hasRemoteImages = true;
}

function copyAllowedProperty(name: string, value: Properties[string]): Properties[string] {
  if (value === null || value === undefined || value === false) return undefined;
  if (name === "reversed") return true;
  if (Array.isArray(value)) return value.map(String).join(" ");
  return value;
}

function propertyText(value: Properties[string]): string | null {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return "";
  if (Array.isArray(value)) return value.map(String).join(" ");
  return String(value);
}

function canonicalHttpsUrl(source: string | null): URL | null {
  if (source === null) return null;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return url;
  } catch {
    return null;
  }
}

function cidMap(
  attachments: ReadonlyArray<MailHtmlAttachment>,
): ReadonlyMap<string, CidResolution> {
  const resolutions = new Map<string, CidResolution>();
  for (const attachment of attachments) {
    if (attachment.contentId === null) continue;
    const contentId = normalizeCid(attachment.contentId);
    if (contentId === "" || resolutions.has(contentId)) {
      if (contentId !== "") resolutions.set(contentId, { kind: "invalid" });
      continue;
    }
    if (!SAFE_IMAGE_TYPES.has(attachment.mimeType.trim().toLowerCase())) {
      resolutions.set(contentId, { kind: "invalid" });
      continue;
    }
    resolutions.set(contentId, { kind: "valid", attachmentId: attachment.id });
  }
  return resolutions;
}

function normalizeCid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).toLowerCase();
  }
  return trimmed.toLowerCase();
}

function sanitizeInlineStyle(source: string | null): string | null {
  if (source === null || new TextEncoder().encode(source).byteLength > MAX_INLINE_STYLE_BYTES) {
    return null;
  }
  let ast: CssNode;
  try {
    ast = parse(source, { context: "declarationList" });
  } catch {
    return null;
  }
  if (ast.type !== "DeclarationList") return null;
  const accepted: string[] = [];
  for (const node of ast.children) {
    if (node.type === "WhiteSpace" || node.type === "Comment") continue;
    if (node.type !== "Declaration") return null;
    if (isAllowedDeclaration(node)) accepted.push(generate(node));
  }
  return accepted.length === 0 ? null : accepted.join(";");
}

function isAllowedDeclaration(declaration: Declaration): boolean {
  const property = declaration.property.toLowerCase();
  if (
    declaration.important !== false ||
    property.startsWith("-") ||
    declaration.value.type !== "Value"
  )
    return false;
  if (COLOR_PROPERTIES.has(property)) return isColorValue(declaration.value);
  if (LENGTH_PROPERTIES.has(property)) return isLengthValue(property, declaration.value);
  if (BORDER_PROPERTIES.has(property)) return isBorderValue(declaration.value);
  const identifiers = IDENTIFIER_PROPERTIES.get(property);
  if (identifiers !== undefined) return containsOnlyIdentifiers(declaration.value, identifiers);
  if (property === "font-family") return isFontFamilyValue(declaration.value);
  if (property === "font-weight") return isFontWeightValue(declaration.value);
  if (property === "line-height") return isLineHeightValue(declaration.value);
  if (property === "vertical-align") return isVerticalAlignValue(declaration.value);
  if (property === "text-decoration" || property === "text-decoration-line")
    return isTextDecorationValue(declaration.value);
  return false;
}

function isColorValue(value: Value): boolean {
  const node = singleNonWhitespaceChild(value);
  if (node === null) return false;
  if (node.type === "Identifier") return COLOR_NAMES.has(node.name.toLowerCase());
  if (node.type === "Hash") return isHexColor(node.value);
  return node.type === "Function" && isColorFunction(node.name, node.children);
}

function isColorFunction(name: string, children: Iterable<CssNode>): boolean {
  const normalizedName = name.toLowerCase();
  if (!COLOR_FUNCTIONS.has(normalizedName)) return false;
  let componentCount = 0;
  for (const node of children) {
    if (node.type === "Number" || node.type === "Percentage") {
      componentCount += 1;
      continue;
    }
    if (node.type === "Dimension" && node.unit.toLowerCase() === "deg") {
      componentCount += 1;
      continue;
    }
    if (node.type === "WhiteSpace") continue;
    if (node.type === "Operator" && COLOR_FUNCTION_OPERATORS.has(node.value)) continue;
    return false;
  }
  return componentCount === 3 || componentCount === 4;
}

function isHexColor(value: string): boolean {
  return /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value);
}

function isLengthValue(property: string, value: Value): boolean {
  const allowedIdentifiers = lengthIdentifiers(property);
  let count = 0;
  for (const node of value.children) {
    if (node.type === "WhiteSpace") continue;
    if (node.type === "Percentage") {
      count += 1;
      continue;
    }
    if (node.type === "Number" && Number(node.value) === 0) {
      count += 1;
      continue;
    }
    if (node.type === "Dimension" && isLengthUnit(node.unit)) {
      count += 1;
      continue;
    }
    if (node.type === "Identifier" && allowedIdentifiers.has(node.name.toLowerCase())) {
      count += 1;
      continue;
    }
    if (property.includes("radius") && node.type === "Operator" && node.value === "/") continue;
    return false;
  }
  return count > 0;
}

function lengthIdentifiers(property: string): ReadonlySet<string> {
  if (property.startsWith("margin")) return new Set(["auto"]);
  if (property === "width" || property.endsWith("width") || property.endsWith("height"))
    return new Set(["auto", "min-content", "max-content", "fit-content"]);
  if (property === "font-size")
    return new Set([
      "xx-small",
      "x-small",
      "small",
      "medium",
      "large",
      "x-large",
      "xx-large",
      "smaller",
      "larger",
    ]);
  if (property === "letter-spacing" || property === "word-spacing") return new Set(["normal"]);
  return new Set();
}

function isLengthUnit(unit: string): boolean {
  return LENGTH_UNITS.has(unit.toLowerCase());
}

function isBorderValue(value: Value): boolean {
  let count = 0;
  for (const node of value.children) {
    if (node.type === "WhiteSpace") continue;
    if (node.type === "Hash" && isHexColor(node.value)) {
      count += 1;
      continue;
    }
    if (node.type === "Number" && Number(node.value) === 0) {
      count += 1;
      continue;
    }
    if (node.type === "Dimension" && isLengthUnit(node.unit)) {
      count += 1;
      continue;
    }
    if (node.type === "Identifier" && BORDER_IDENTIFIERS.has(node.name.toLowerCase())) {
      count += 1;
      continue;
    }
    if (node.type === "Function" && isColorFunction(node.name, node.children)) {
      count += 1;
      continue;
    }
    return false;
  }
  return count > 0;
}

function containsOnlyIdentifiers(value: Value, allowed: ReadonlySet<string>): boolean {
  let count = 0;
  for (const node of value.children) {
    if (node.type === "WhiteSpace") continue;
    if (node.type !== "Identifier" || !allowed.has(node.name.toLowerCase())) return false;
    count += 1;
  }
  return count > 0;
}

function isFontFamilyValue(value: Value): boolean {
  let count = 0;
  for (const node of value.children) {
    if (node.type === "WhiteSpace") continue;
    if (node.type === "Identifier") {
      if (CSS_WIDE_KEYWORDS.has(node.name.toLowerCase())) return false;
      count += 1;
      continue;
    }
    if (node.type === "String") {
      count += 1;
      continue;
    }
    if (node.type === "Operator" && node.value === ",") continue;
    return false;
  }
  return count > 0;
}

function isFontWeightValue(value: Value): boolean {
  const node = singleNonWhitespaceChild(value);
  if (node === null) return false;
  if (node.type === "Identifier") return FONT_WEIGHTS.has(node.name.toLowerCase());
  return node.type === "Number" && Number(node.value) >= 1 && Number(node.value) <= 1000;
}

function isLineHeightValue(value: Value): boolean {
  const node = singleNonWhitespaceChild(value);
  if (node === null) return false;
  if (node.type === "Number" || node.type === "Percentage") return true;
  if (node.type === "Dimension") return isLengthUnit(node.unit);
  return node.type === "Identifier" && node.name.toLowerCase() === "normal";
}

function isTextDecorationValue(value: Value): boolean {
  return containsOnlyIdentifiers(value, TEXT_DECORATIONS);
}

function isVerticalAlignValue(value: Value): boolean {
  const node = singleNonWhitespaceChild(value);
  if (node === null) return false;
  if (node.type === "Percentage") return true;
  if (node.type === "Number") return Number(node.value) === 0;
  if (node.type === "Dimension") return isLengthUnit(node.unit);
  return node.type === "Identifier" && VERTICAL_ALIGNMENTS.has(node.name.toLowerCase());
}

function singleNonWhitespaceChild(value: Value): CssNode | null {
  let child: CssNode | null = null;
  for (const node of value.children) {
    if (node.type === "WhiteSpace") continue;
    if (child !== null) return null;
    child = node;
  }
  return child;
}
