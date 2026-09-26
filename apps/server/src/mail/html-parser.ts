import {
  defaultTreeAdapter,
  html,
  Parser,
  Tokenizer,
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  type ParserOptions,
  type TreeAdapter,
} from "parse5";

import * as Schema from "effect/Schema";

export const MAIL_HTML_PARSE_LIMITS = {
  inputBytes: 2 * 1024 * 1024,
  allocatedNodes: 20_000,
  openElements: 128,
  finalTreeDepth: 128,
  attributesPerElement: 64,
  admittedAttributes: 80_000,
} as const;

export const MailHtmlResourceLimit = Schema.Literals([
  "admitted_attributes",
  "allocated_nodes",
  "attributes_per_element",
  "final_tree_depth",
  "input_bytes",
  "open_elements",
]);
export type MailHtmlResourceLimit = typeof MailHtmlResourceLimit.Type;

// The limit as a person reads it, e.g. "The HTML body exceeds the 128-level nesting limit."
export function describeMailHtmlLimit(limit: MailHtmlResourceLimit): string {
  switch (limit) {
    case "admitted_attributes":
      return `${MAIL_HTML_PARSE_LIMITS.admittedAttributes}-attribute`;
    case "allocated_nodes":
      return `${MAIL_HTML_PARSE_LIMITS.allocatedNodes}-node`;
    case "attributes_per_element":
      return `${MAIL_HTML_PARSE_LIMITS.attributesPerElement}-attributes-per-element`;
    case "final_tree_depth":
    case "open_elements":
      return `${MAIL_HTML_PARSE_LIMITS.openElements}-level nesting`;
    case "input_bytes":
      return `${MAIL_HTML_PARSE_LIMITS.inputBytes / 1024 / 1024} MiB size`;
  }
}

export class MailHtmlResourceExhaustion extends Schema.TaggedError<MailHtmlResourceExhaustion>()(
  "MailHtmlResourceExhaustion",
  { limit: MailHtmlResourceLimit },
) {}

type MailHtmlDepthFrame = {
  readonly node: DefaultTreeAdapterTypes.ParentNode;
  readonly depth: number;
};

class BoundedMailHtmlTokenizer extends Tokenizer {
  private readonly currentTagAttributeNames = new Set<string>();

  protected override _createStartTagToken(): void {
    this.currentTagAttributeNames.clear();
    super._createStartTagToken();
  }

  protected override _createEndTagToken(): void {
    this.currentTagAttributeNames.clear();
    super._createEndTagToken();
  }

  protected override _leaveAttrName(): void {
    const normalizedName = this.currentAttr.name;
    if (!this.currentTagAttributeNames.has(normalizedName)) {
      if (this.currentTagAttributeNames.size >= MAIL_HTML_PARSE_LIMITS.attributesPerElement) {
        throw new MailHtmlResourceExhaustion({ limit: "attributes_per_element" });
      }
      this.currentTagAttributeNames.add(normalizedName);
    }
    super._leaveAttrName();
  }
}

class BoundedMailHtmlParser extends Parser<DefaultTreeAdapterMap> {
  constructor(
    options?: ParserOptions<DefaultTreeAdapterMap>,
    document?: DefaultTreeAdapterTypes.Document,
    fragmentContext?: DefaultTreeAdapterTypes.Element | null,
    scriptHandler?: null | ((pendingScript: DefaultTreeAdapterTypes.Element) => void),
  ) {
    super(options, document, fragmentContext, scriptHandler);
    const inForeignNode = this.tokenizer.inForeignNode;
    this.tokenizer = new BoundedMailHtmlTokenizer(this.options, this);
    this.tokenizer.inForeignNode = inForeignNode;
  }
}

class MailHtmlParseBudget {
  private allocatedNodes = 0;
  private admittedAttributes = 0;
  private openElements = 0;

  admitNode(): void {
    if (this.allocatedNodes >= MAIL_HTML_PARSE_LIMITS.allocatedNodes) {
      throw new MailHtmlResourceExhaustion({ limit: "allocated_nodes" });
    }
    this.allocatedNodes += 1;
  }

  admitElement(attributes: number): void {
    this.checkAttributes(0, attributes);
    this.admitNode();
    this.admittedAttributes += attributes;
  }

  adoptAttributes(current: number, appended: number): void {
    this.checkAttributes(current, appended);
    this.admittedAttributes += appended;
  }

  pushOpenElement(): void {
    this.openElements += 1;
    if (this.openElements > MAIL_HTML_PARSE_LIMITS.openElements) {
      throw new MailHtmlResourceExhaustion({ limit: "open_elements" });
    }
  }

  popOpenElement(): void {
    this.openElements -= 1;
  }

  private checkAttributes(current: number, appended: number): void {
    if (current + appended > MAIL_HTML_PARSE_LIMITS.attributesPerElement) {
      throw new MailHtmlResourceExhaustion({ limit: "attributes_per_element" });
    }
    if (this.admittedAttributes + appended > MAIL_HTML_PARSE_LIMITS.admittedAttributes) {
      throw new MailHtmlResourceExhaustion({ limit: "admitted_attributes" });
    }
  }
}

export function parseBoundedMailHtmlFragment(
  html: string,
): DefaultTreeAdapterTypes.DocumentFragment {
  if (
    html.length > MAIL_HTML_PARSE_LIMITS.inputBytes ||
    new TextEncoder().encode(html).byteLength > MAIL_HTML_PARSE_LIMITS.inputBytes
  ) {
    throw new MailHtmlResourceExhaustion({ limit: "input_bytes" });
  }

  const parser = BoundedMailHtmlParser.getFragmentParser<DefaultTreeAdapterMap>(null, {
    treeAdapter: createBoundedTreeAdapter(),
  });
  parser.tokenizer.write(html, true);
  const fragment = parser.getFragment();
  validateFinalTreeDepth(fragment);
  return fragment;
}

function createBoundedTreeAdapter(): TreeAdapter<DefaultTreeAdapterMap> {
  const budget = new MailHtmlParseBudget();
  return {
    ...defaultTreeAdapter,
    createDocumentFragment() {
      budget.admitNode();
      return defaultTreeAdapter.createDocumentFragment();
    },
    createElement(tagName, namespaceURI, attrs) {
      budget.admitElement(attrs.length);
      const element = defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
      // hast-util-from-parse5 reads `content` from every `template`, including SVG/MathML ones.
      if (tagName === "template" && namespaceURI !== html.NS.HTML) {
        Object.assign(element, { content: defaultTreeAdapter.createDocumentFragment() });
      }
      return element;
    },
    createCommentNode(data) {
      budget.admitNode();
      return defaultTreeAdapter.createCommentNode(data);
    },
    createTextNode(value) {
      budget.admitNode();
      return defaultTreeAdapter.createTextNode(value);
    },
    insertText(parentNode, text) {
      const previous = defaultTreeAdapter.getChildNodes(parentNode).at(-1);
      if (previous === undefined || !defaultTreeAdapter.isTextNode(previous)) {
        budget.admitNode();
      }
      defaultTreeAdapter.insertText(parentNode, text);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      const children = defaultTreeAdapter.getChildNodes(parentNode);
      const previous = children[children.indexOf(referenceNode) - 1];
      if (previous === undefined || !defaultTreeAdapter.isTextNode(previous)) {
        budget.admitNode();
      }
      defaultTreeAdapter.insertTextBefore(parentNode, text, referenceNode);
    },
    adoptAttributes(recipient, attrs) {
      const current = defaultTreeAdapter.getAttrList(recipient);
      const currentNames = new Set(current.map((attribute) => attribute.name));
      let appended = 0;
      for (const attribute of attrs) {
        if (!currentNames.has(attribute.name)) {
          appended += 1;
        }
      }
      budget.adoptAttributes(current.length, appended);
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
    },
    onItemPush() {
      budget.pushOpenElement();
    },
    onItemPop() {
      budget.popOpenElement();
    },
  } satisfies TreeAdapter<DefaultTreeAdapterMap>;
}

function validateFinalTreeDepth(fragment: DefaultTreeAdapterTypes.DocumentFragment): void {
  const stack: MailHtmlDepthFrame[] = [{ node: fragment, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      continue;
    }
    for (const child of defaultTreeAdapter.getChildNodes(frame.node)) {
      const depth = frame.depth + 1;
      if (depth > MAIL_HTML_PARSE_LIMITS.finalTreeDepth) {
        throw new MailHtmlResourceExhaustion({ limit: "final_tree_depth" });
      }
      if (!defaultTreeAdapter.isElementNode(child)) {
        continue;
      }
      stack.push({ node: child, depth });
      if (isMailHtmlTemplate(child)) {
        const contentDepth = depth + 1;
        if (contentDepth > MAIL_HTML_PARSE_LIMITS.finalTreeDepth) {
          throw new MailHtmlResourceExhaustion({ limit: "final_tree_depth" });
        }
        stack.push({ node: child.content, depth: contentDepth });
      }
    }
  }
}

function isMailHtmlTemplate(
  element: DefaultTreeAdapterTypes.Element,
): element is DefaultTreeAdapterTypes.Template {
  return element.tagName === "template" && "content" in element;
}
