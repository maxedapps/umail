import type { CssNode, Declaration, DeclarationList, Value } from "css-tree";
import generate from "css-tree/generator";
import parse from "css-tree/parser";
import type { Element, ElementContent, Properties, Root, RootContent } from "hast";
import { fromParse5 } from "hast-util-from-parse5";
import { toHtml } from "hast-util-to-html";
import rehypeSanitize from "rehype-sanitize";
import type { Options as MailHtmlSanitizeSchema } from "rehype-sanitize";
import { unified } from "unified";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MailHtmlResourceExhaustion, parseBoundedMailHtmlFragment } from "./mail-html-parser.ts";

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

const MAIL_HTML_POLICY_VERSION = 1 as const;
type MailHtmlPolicyVersion = typeof MAIL_HTML_POLICY_VERSION;
const MAX_INLINE_STYLE_BYTES = 8 * 1024;
const REMOTE_SOURCE_PROPERTY = "dataUmailRemoteSrc";
const LINK_REL_TOKENS = ["noopener", "noreferrer", "nofollow"] as const;
const LINK_REL = "noopener noreferrer nofollow";

type MailHtmlSanitizeMode = "storage" | "activated";

type MailHtmlNormalizeContext = {
  readonly messageId: string;
  readonly cidResolutions: ReadonlyMap<string, CidResolution>;
  hasRemoteImages: boolean;
};

const ALLOWED_ELEMENTS = new Set([
  "a",
  "abbr",
  "address",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
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
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
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
  "u",
  "ul",
  "var",
  "wbr",
]);

const UNWRAPPED_ELEMENTS = new Set(["html", "body"]);

const REMOVED_SUBTREES = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "form",
  "frame",
  "frameset",
  "head",
  "iframe",
  "input",
  "label",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "optgroup",
  "option",
  "picture",
  "portal",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "track",
  "video",
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
  [
    "border-style",
    new Set([
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
    ]),
  ],
  [
    "border-top-style",
    new Set([
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
    ]),
  ],
  [
    "border-right-style",
    new Set([
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
    ]),
  ],
  [
    "border-bottom-style",
    new Set([
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
    ]),
  ],
  [
    "border-left-style",
    new Set([
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
    ]),
  ],
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
const BORDER_IDENTIFIERS = new Set([
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
  "thin",
  "medium",
  "thick",
  ...COLOR_NAMES,
]);
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
    materializeRemoteImages(materialization) {
      return Effect.try({
        try: () => materializeStoredMailHtml(materialization),
        catch: mailHtmlPolicyErrorFromCause,
      });
    },
  };
}

function sanitizeHtmlForStorage(html: string, sanitization: MailHtmlSanitization): StoredMailHtml {
  const stored = canonicalizeMailHtmlForStorage(html, sanitization);
  parseStoredMailHtml(stored.body);
  return stored;
}

function canonicalizeMailHtmlForStorage(
  html: string,
  sanitization: MailHtmlSanitization,
): StoredMailHtml {
  const tree = parseMailHtmlFragment(html);
  const stripTagNames = collectStripTagNames(tree);
  const context: MailHtmlNormalizeContext = {
    messageId: sanitization.messageId,
    cidResolutions: cidMap(sanitization.attachments),
    hasRemoteImages: false,
  };
  const normalized = {
    type: "root",
    children: normalizeChildren(tree.children, context),
  } satisfies Root;
  const sanitized = sanitizeMailHtmlTree(normalized, stripTagNames, "storage");
  return {
    body: serializeMailHtml(sanitized),
    hasRemoteImages: context.hasRemoteImages,
  };
}

const STORED_MAIL_HTML_VALIDATORS = {
  1: isValidStoredMailHtmlForPolicy1,
} as const satisfies Record<MailHtmlPolicyVersion, (root: Root) => boolean>;

const MAIL_HTML_INLINE_STYLE_VALIDATORS = {
  1: isPolicyEquivalentInlineStyleForPolicy1,
} as const satisfies Record<MailHtmlPolicyVersion, (style: string) => boolean>;

function materializeStoredMailHtml(materialization: MailHtmlMaterialization): string {
  const tree = parseStoredMailHtml(materialization.body);
  activateRemoteImages(tree, materialization.applicationUrl.origin);
  const sanitized = sanitizeMailHtmlTree(tree, collectStripTagNames(tree), "activated");
  return serializeMailHtml(sanitized);
}

function parseStoredMailHtml(body: string): Root {
  const tree = parseMailHtmlFragment(body);
  if (!STORED_MAIL_HTML_VALIDATORS[MAIL_HTML_POLICY_VERSION](tree)) {
    throw new Error(`invalid stored mail HTML for policy ${String(MAIL_HTML_POLICY_VERSION)}`);
  }
  return tree;
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

function serializeMailHtml(tree: Root): string {
  return toHtml(tree);
}

function sanitizeMailHtmlTree(
  tree: Root,
  stripTagNames: ReadonlySet<string>,
  mode: MailHtmlSanitizeMode,
): Root {
  return unified().use(rehypeSanitize, mailHtmlSanitizeSchema(stripTagNames, mode)).runSync(tree);
}

function mailHtmlSanitizeSchema(
  stripTagNames: ReadonlySet<string>,
  mode: MailHtmlSanitizeMode,
): MailHtmlSanitizeSchema {
  const img =
    mode === "activated"
      ? ["alt", "height", "width", "src", REMOTE_SOURCE_PROPERTY, "referrerPolicy"]
      : ["alt", "height", "width", "src", REMOTE_SOURCE_PROPERTY];
  return {
    allowComments: false,
    allowDoctypes: false,
    ancestors: {},
    attributes: {
      "*": ["ariaHidden", "ariaLabel", "dir", "lang", "role", "title", "style"],
      a: ["href", "target", "rel", "referrerPolicy"],
      img,
      li: ["value"],
      ol: ["reversed", "start", "type"],
      td: ["colSpan", "headers", "rowSpan"],
      th: ["colSpan", "headers", "rowSpan", "scope"],
      time: ["dateTime"],
    },
    clobber: [],
    clobberPrefix: "",
    protocols: {
      href: ["https"],
      src: ["https"],
      [REMOTE_SOURCE_PROPERTY]: ["https"],
    },
    required: {},
    strip: [...stripTagNames],
    tagNames: [...ALLOWED_ELEMENTS],
  };
}

function collectStripTagNames(root: Root): Set<string> {
  const strip = new Set(REMOVED_SUBTREES);
  visit(root.children);
  return strip;

  function visit(nodes: ReadonlyArray<RootContent>): void {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      if (!ALLOWED_ELEMENTS.has(node.tagName) && !UNWRAPPED_ELEMENTS.has(node.tagName)) {
        strip.add(node.tagName);
      }
      visit(node.children);
      if (node.content !== undefined) visit(node.content.children);
    }
  }
}

function normalizeChildren(
  children: ReadonlyArray<RootContent>,
  context: MailHtmlNormalizeContext,
): ElementContent[] {
  const result: ElementContent[] = [];
  for (const child of children) {
    if (child.type === "text") {
      result.push(child);
      continue;
    }
    if (child.type !== "element") continue;
    if (UNWRAPPED_ELEMENTS.has(child.tagName)) {
      for (const unwrapped of normalizeChildren(child.children, context)) result.push(unwrapped);
      continue;
    }
    if (!ALLOWED_ELEMENTS.has(child.tagName)) continue;
    result.push(normalizeAllowedElement(child, context));
  }
  return result;
}

function normalizeAllowedElement(element: Element, context: MailHtmlNormalizeContext): Element {
  const tagName = element.tagName;
  const source = tagName === "img" ? propertyText(element.properties.src) : null;
  const href = tagName === "a" ? propertyText(element.properties.href) : null;
  const style = propertyText(element.properties.style);
  const properties: Properties = {};
  const elementProperties = ELEMENT_PROPERTIES.get(tagName);
  for (const name of Object.keys(element.properties)) {
    if (!GLOBAL_PROPERTIES.has(name) && elementProperties?.has(name) !== true) continue;
    const copied = copyAllowedProperty(name, element.properties[name]);
    if (copied !== undefined) properties[name] = copied;
  }
  if (style !== null) {
    const sanitizedStyle = sanitizeInlineStyle(style);
    if (sanitizedStyle !== null) properties.style = sanitizedStyle;
  }
  if (href !== null) rewriteAnchor(properties, href);
  if (source !== null) rewriteImageSource(properties, source, context);
  return {
    type: "element",
    tagName,
    properties,
    children: normalizeChildren(element.children, context),
  };
}

function rewriteAnchor(properties: Properties, source: string): void {
  const url = canonicalHttpsUrl(source);
  if (url === null) return;
  properties.href = url.href;
  properties.target = "_blank";
  properties.rel = [...LINK_REL_TOKENS];
  properties.referrerPolicy = "no-referrer";
}

function rewriteImageSource(
  properties: Properties,
  source: string,
  context: MailHtmlNormalizeContext,
): void {
  const trimmed = source.trim();
  if (trimmed.toLowerCase().startsWith("cid:")) {
    const resolution = context.cidResolutions.get(normalizeCid(trimmed.slice(4)));
    if (resolution?.kind !== "valid") return;
    properties.src = `/messages/${encodeURIComponent(context.messageId)}/attachments/${encodeURIComponent(resolution.attachmentId)}`;
    return;
  }
  const url = canonicalHttpsUrl(trimmed);
  if (url === null) return;
  properties[REMOTE_SOURCE_PROPERTY] = url.href;
  context.hasRemoteImages = true;
}

function activateRemoteImages(root: Root, applicationOrigin: string): void {
  visitElements(root.children, (element) => {
    if (element.tagName !== "img") return;
    const remote = propertyText(element.properties[REMOTE_SOURCE_PROPERTY]);
    if (remote === null) return;
    const url = canonicalHttpsUrl(remote);
    if (url === null || url.href !== remote || url.origin === applicationOrigin) return;
    element.properties.src = url.href;
    element.properties.referrerPolicy = "no-referrer";
  });
}

function visitElements(nodes: ReadonlyArray<RootContent>, visit: (element: Element) => void): void {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    visit(node);
    visitElements(node.children, visit);
  }
}

function isValidStoredMailHtmlForPolicy1(root: Root): boolean {
  return root.children.every(isValidStoredChild);
}

function isValidStoredChild(node: RootContent): boolean {
  if (node.type === "text") return true;
  if (node.type !== "element") return false;
  return isValidStoredElement(node);
}

function isValidStoredElement(element: Element): boolean {
  if (!ALLOWED_ELEMENTS.has(element.tagName)) return false;
  const elementProperties = ELEMENT_PROPERTIES.get(element.tagName);
  for (const name of Object.keys(element.properties)) {
    if (name === "style" || GLOBAL_PROPERTIES.has(name) || elementProperties?.has(name) === true) {
      continue;
    }
    if (isStorageSpecialProperty(element.tagName, name)) continue;
    const value = element.properties[name];
    if (value === null || value === undefined || value === false) continue;
    return false;
  }
  const style = propertyText(element.properties.style);
  if (style !== null && !isValidStoredInlineStyle(style)) return false;
  if (element.tagName === "a" && !isValidStoredAnchor(element)) return false;
  if (element.tagName === "img" && !isValidStoredImage(element)) return false;
  return element.children.every(isValidStoredChild);
}

function isStorageSpecialProperty(tagName: string, name: string): boolean {
  if (tagName === "a") {
    return name === "href" || name === "target" || name === "rel" || name === "referrerPolicy";
  }
  if (tagName === "img") {
    return name === "src" || name === REMOTE_SOURCE_PROPERTY;
  }
  return false;
}

function isValidStoredAnchor(element: Element): boolean {
  const href = propertyText(element.properties.href);
  const target = propertyText(element.properties.target);
  const rel = propertyText(element.properties.rel);
  const referrerPolicy = propertyText(element.properties.referrerPolicy);
  if (href === null) {
    return target === null && rel === null && referrerPolicy === null;
  }
  const url = canonicalHttpsUrl(href);
  return (
    url !== null &&
    url.href === href &&
    target === "_blank" &&
    rel === LINK_REL &&
    referrerPolicy === "no-referrer"
  );
}

function isValidStoredImage(element: Element): boolean {
  const source = propertyText(element.properties.src);
  const remoteSource = propertyText(element.properties[REMOTE_SOURCE_PROPERTY]);
  if (
    propertyText(element.properties.referrerPolicy) !== null ||
    (source !== null && remoteSource !== null)
  ) {
    return false;
  }
  if (remoteSource !== null) {
    const url = canonicalHttpsUrl(remoteSource);
    return url !== null && url.href === remoteSource;
  }
  if (source !== null) return isCanonicalCidAttachmentPath(source);
  return true;
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

function isCanonicalCidAttachmentPath(source: string): boolean {
  if (!source.startsWith("/messages/")) return false;
  let url: URL;
  try {
    url = new URL(source, "https://canonical-mail-html.invalid");
  } catch {
    return false;
  }
  if (
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== "https://canonical-mail-html.invalid"
  ) {
    return false;
  }
  const segments = url.pathname.split("/");
  const messageId = segments[2];
  const attachmentId = segments[4];
  if (
    segments.length !== 5 ||
    segments[1] !== "messages" ||
    segments[3] !== "attachments" ||
    messageId === undefined ||
    messageId === "" ||
    attachmentId === undefined ||
    attachmentId === ""
  ) {
    return false;
  }
  try {
    return (
      encodeURIComponent(decodeURIComponent(messageId)) === messageId &&
      encodeURIComponent(decodeURIComponent(attachmentId)) === attachmentId
    );
  } catch {
    return false;
  }
}

function canonicalHttpsUrl(source: string): URL | null {
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

function isValidStoredInlineStyle(style: string): boolean {
  return MAIL_HTML_INLINE_STYLE_VALIDATORS[MAIL_HTML_POLICY_VERSION](style);
}

function isPolicyEquivalentInlineStyleForPolicy1(source: string): boolean {
  const stored = parseInlineStyle(source);
  if (stored === null) return false;
  const policyCss = sanitizeParsedInlineStyleForPolicy1(stored);
  if (policyCss === null) return false;
  const policy = parseInlineStyle(policyCss);
  return policy !== null && semanticallyEqualCssNodes(stored, policy);
}

function sanitizeInlineStyle(source: string): string | null {
  const stored = parseInlineStyle(source);
  if (stored === null) return null;
  return sanitizeParsedInlineStyleForPolicy1(stored);
}

function parseInlineStyle(source: string): DeclarationList | null {
  if (new TextEncoder().encode(source).byteLength > MAX_INLINE_STYLE_BYTES) return null;
  let ast: CssNode;
  try {
    ast = parse(source, { context: "declarationList" });
  } catch {
    return null;
  }
  return ast.type === "DeclarationList" ? ast : null;
}

function sanitizeParsedInlineStyleForPolicy1(stored: DeclarationList): string | null {
  const accepted: string[] = [];
  for (const node of stored.children) {
    if (node.type === "WhiteSpace" || node.type === "Comment") continue;
    if (node.type !== "Declaration") return null;
    if (isAllowedDeclaration(node)) accepted.push(generate(node));
  }
  return accepted.length === 0 ? null : accepted.join(";");
}

function semanticallyEqualCssNodes(left: CssNode, right: CssNode): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "DeclarationList":
      return (
        right.type === "DeclarationList" &&
        semanticallyEqualCssNodeLists(left.children, right.children)
      );
    case "Declaration":
      return (
        right.type === "Declaration" &&
        left.property.toLowerCase() === right.property.toLowerCase() &&
        left.important === right.important &&
        semanticallyEqualCssNodes(left.value, right.value)
      );
    case "Value":
      return right.type === "Value" && semanticallyEqualCssNodeLists(left.children, right.children);
    case "Function":
      return (
        right.type === "Function" &&
        left.name.toLowerCase() === right.name.toLowerCase() &&
        semanticallyEqualCssNodeLists(left.children, right.children)
      );
    case "Identifier":
      return right.type === "Identifier" && left.name.toLowerCase() === right.name.toLowerCase();
    case "Hash":
      return right.type === "Hash" && left.value.toLowerCase() === right.value.toLowerCase();
    case "Dimension":
      return (
        right.type === "Dimension" &&
        left.value === right.value &&
        left.unit.toLowerCase() === right.unit.toLowerCase()
      );
    case "Number":
      return right.type === "Number" && left.value === right.value;
    case "Percentage":
      return right.type === "Percentage" && left.value === right.value;
    case "Operator":
      return right.type === "Operator" && left.value === right.value;
    case "String":
      return right.type === "String" && left.value === right.value;
    default:
      return false;
  }
}

function semanticallyEqualCssNodeLists(left: Iterable<CssNode>, right: Iterable<CssNode>): boolean {
  const leftNodes = significantCssNodes(left);
  const rightNodes = significantCssNodes(right);
  if (leftNodes.length !== rightNodes.length) return false;
  for (let index = 0; index < leftNodes.length; index += 1) {
    const leftNode = leftNodes[index];
    const rightNode = rightNodes[index];
    if (leftNode === undefined || rightNode === undefined) return false;
    if (!semanticallyEqualCssNodes(leftNode, rightNode)) return false;
  }
  return true;
}

function significantCssNodes(nodes: Iterable<CssNode>): CssNode[] {
  const significant: CssNode[] = [];
  for (const node of nodes) {
    if (node.type === "WhiteSpace" || node.type === "Comment") continue;
    significant.push(node);
  }
  return significant;
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
