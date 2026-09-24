import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { describe, expect, it } from "vitest";

import {
  createMailHtmlPolicy,
  type MailHtmlAttachment,
  type StoredMailHtml,
} from "../../src/mail/html-policy.ts";
import {
  MAIL_HTML_PARSE_LIMITS,
  MailHtmlResourceExhaustion,
  parseBoundedMailHtmlFragment,
} from "../../src/mail/html-parser.ts";

const MESSAGE_ID = "in_worker_corpus";
const APPLICATION_URL = new URL("https://mail.umail.test/inbox");

type MailHtmlElement = DefaultTreeAdapterMap["element"];
type MailHtmlNode = DefaultTreeAdapterMap["childNode"];

describe("MailHtmlPolicy storage sanitizer", () => {
  it("preserves semantic and table markup while removing comments and non-policy attributes", () =>
    sanitize(
      '<!--top--><DIV title="kept" DATA-remove="gone" OnClick="bad()"><P lang="en">fragment<!--inside--></P></DIV><table><thead><tr><th colspan="2" scope="col">Heading</th></tr></thead><tbody><tr><td rowspan="2">Cell</td></tr></tbody></table>',
    ).then((result) => {
      expect(result.hasRemoteImages).toBe(false);
      expect(hasComment(result.body)).toBe(false);
      expect(tags(result.body)).toEqual([
        "div",
        "p",
        "table",
        "thead",
        "tr",
        "th",
        "tbody",
        "tr",
        "td",
      ]);
      expect(attributeOf(result.body, "div", "title")).toBe("kept");
      expect(attributeOf(result.body, "div", "data-remove")).toBeUndefined();
      expect(attributeOf(result.body, "div", "onclick")).toBeUndefined();
      expect(attributeOf(result.body, "p", "lang")).toBe("en");
      expect(textOf(result.body, "p")).toBe("fragment");
      expect(attributeOf(result.body, "th", "colspan")).toBe("2");
      expect(attributeOf(result.body, "th", "scope")).toBe("col");
      expect(attributeOf(result.body, "td", "rowspan")).toBe("2");
    }));

  it("drops raw-text, foreign, and template elements with their content", () => {
    const dropped = [
      "script",
      "style",
      "iframe",
      "noscript",
      "noembed",
      "noframes",
      "svg",
      "math",
      "template",
      "select",
      "textarea",
      "title",
      "xmp",
    ];
    const hostile = dropped.map((tag) => `<${tag}>secret-${tag}</${tag}>`).join("");
    return sanitize(`<p>before</p>${hostile}<p>after</p>`).then((result) => {
      expect(result.body).toBe("<p>before</p><p>after</p>");
    });
  });

  it("unwraps unknown and legacy containers so their text survives", () =>
    sanitize(
      '<div dir="ltr"><font face="verdana" color="#888">Please wire the payment</font></div><form action="https://evil.test/"><button formaction="https://evil.test/">Rate</button></form><custom-element onclick="bad()">custom</custom-element><p>Hello<o:p>&nbsp;</o:p><st1:place>Vienna</st1:place></p><object data="https://evil.test/x"><p>fallback</p></object>',
    ).then((result) => {
      expect(result.body).toBe(
        '<div dir="ltr">Please wire the payment</div>Ratecustom<p>Hello\u00a0Vienna</p><p>fallback</p>',
      );
    }));

  it("keeps the 12 sectioning/legacy elements without attributes", () => {
    const kept = ["center", "section", "article", "header", "footer", "main", "nav", "aside"];
    const inline = ["strike", "big", "tt", "nobr"];
    return sanitize(
      [...kept, ...inline]
        .map((tag) => `<${tag} align="center" onclick="bad()">${tag}-text</${tag}>`)
        .join(""),
    ).then((result) => {
      expect(result.body).toBe(
        [...kept, ...inline].map((tag) => `<${tag}>${tag}-text</${tag}>`).join(""),
      );
    });
  });

  it("sanitizes templates nested in SVG/MathML", () =>
    sanitize(
      "<p>before</p><svg><template><p>x</p></template></svg><math><template></template></math><p>after</p>",
    ).then((result) => expect(result.body).toBe("<p>before</p><p>x</p><p>after</p>")));

  it("removes void resources, event handlers, and alternate resource attributes", () =>
    sanitize(
      '<base href="https://evil.test/"><link rel="stylesheet" href="https://evil.test/x.css"><meta http-equiv="refresh" content="0;url=https://evil.test"><embed src="https://evil.test/x"><input formaction="https://evil.test/"><img alt="kept" width="10" onclick="x" srcset="https://evil.test/x 1x" background="https://evil.test/x" ping="https://evil.test/x" poster="https://evil.test/x" lowsrc="https://evil.test/x" dynsrc="https://evil.test/x" xlink:href="https://evil.test/x" srcdoc="bad">',
    ).then((result) => {
      expect(tags(result.body)).toEqual(["img"]);
      expect(attributeOf(result.body, "img", "alt")).toBe("kept");
      expect(attributeOf(result.body, "img", "width")).toBe("10");
      expect(attributeOf(result.body, "img", "src")).toBeUndefined();
      expect(attributeOf(result.body, "img", "onclick")).toBeUndefined();
      expect(attributeOf(result.body, "img", "srcset")).toBeUndefined();
      expect(result.body).not.toContain("evil.test");
    }));

  it("repairs malformed fragments without admitting removed content", () =>
    sanitize('<p title="ok"><b>bold<img src="javascript:alert(1)"><script>bad').then((result) => {
      expect(attributeOf(result.body, "p", "title")).toBe("ok");
      expect(textOf(result.body, "b")).toBe("bold");
      expect(descendantElements(result.body, "img")).toHaveLength(1);
      expect(attributeOf(result.body, "img", "src")).toBeUndefined();
      expect(descendantElements(result.body, "script")).toHaveLength(0);
      expect(result.body).not.toContain("javascript");
      expect(result.body).not.toContain("bad");
    }));

  it("unwraps document containers and removes the complete head subtree", () =>
    sanitize(
      '<html><head><base href="https://evil.test/"><title>bad</title></head><body><p>body</p></body></html>',
    ).then((result) => {
      expect(descendantElements(result.body, "html")).toHaveLength(0);
      expect(descendantElements(result.body, "head")).toHaveLength(0);
      expect(descendantElements(result.body, "body")).toHaveLength(0);
      expect(descendantElements(result.body, "title")).toHaveLength(0);
      expect(texts(result.body, "p")).toEqual(["body"]);
      expect(result.body).not.toContain("evil.test");
      expect(result.body).not.toContain("bad");
    }));

  it("retains and canonically generates the bounded presentation property families", () =>
    sanitize(
      '<table style="border-collapse: collapse; border-spacing: 0 4px; table-layout: fixed; width: 100%; background-color: rgb(255, 255, 255)"><tr><td style="font-family: Arial, sans-serif; font-size: 14px; font-weight: 700; font-style: italic; line-height: 1.5; text-align: center; text-decoration: underline; text-transform: uppercase; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; margin: 0 auto; padding: 4px 8px; border: 1px solid #abc; border-radius: 4px; vertical-align: middle; display: table-cell; color: #123456">Cell</td></tr></table>',
    ).then((result) => {
      const tableStyle = styleOf(result.body, "table");
      expect(tableStyle.get("border-collapse")).toBe("collapse");
      expect(tableStyle.get("border-spacing")).toBe("0 4px");
      expect(tableStyle.get("table-layout")).toBe("fixed");
      expect(tableStyle.get("width")).toBe("100%");
      expect(tableStyle.get("background-color")).toMatch(/^rgb\(255,\s*255,\s*255\)$/u);
      const cellStyle = styleOf(result.body, "td");
      expect(cellStyle.get("font-family")).toMatch(/Arial/u);
      expect(cellStyle.get("font-size")).toBe("14px");
      expect(cellStyle.get("font-weight")).toBe("700");
      expect(cellStyle.get("font-style")).toBe("italic");
      expect(cellStyle.get("line-height")).toBe("1.5");
      expect(cellStyle.get("text-align")).toBe("center");
      expect(cellStyle.get("text-decoration")).toBe("underline");
      expect(cellStyle.get("text-transform")).toBe("uppercase");
      expect(cellStyle.get("white-space")).toBe("pre-wrap");
      expect(cellStyle.get("word-break")).toBe("break-word");
      expect(cellStyle.get("overflow-wrap")).toBe("anywhere");
      expect(cellStyle.get("margin")).toBe("0 auto");
      expect(cellStyle.get("padding")).toBe("4px 8px");
      expect(cellStyle.get("border")).toMatch(/1px/u);
      expect(cellStyle.get("border-radius")).toBe("4px");
      expect(cellStyle.get("vertical-align")).toBe("middle");
      expect(cellStyle.get("display")).toBe("table-cell");
      expect(cellStyle.get("color")).toBe("#123456");
    }));

  it("drops every denied property while retaining independent safe declarations", () => {
    const denied = [
      "background-image:url(https://tracker.test/pixel)",
      "position:fixed",
      "z-index:999",
      "overflow:hidden",
      "opacity:.01",
      "visibility:hidden",
      "transform:scale(2)",
      "filter:blur(1px)",
      "animation:spin 1s",
      "transition:all 1s",
      "cursor:pointer",
      "behavior:url(x)",
      "content:'secret'",
      "--custom:red",
      "-webkit-transform:none",
    ].join(";");
    return sanitize(`<p style="color: red;${denied};padding: 2px">safe</p>`).then((result) => {
      const style = styleOf(result.body, "p");
      expect(style.get("color")).toBe("red");
      expect(style.get("padding")).toBe("2px");
      expect(style.size).toBe(2);
      expect(result.body).not.toContain("tracker.test");
      expect(result.body).not.toContain("url(");
      expect(result.body).not.toContain("position");
      expect(result.body).not.toContain("--custom");
    });
  });

  it("rejects lexer-gap values while retaining independent safe declarations", () =>
    sanitize(
      '<p style="color:foo">unknown color</p><p style="color:red blue">extra color</p><p style="color:inherit">inherited color</p><p style="color:currentcolor">current color</p><p style="line-height:1 2">extra line height</p><p style="border:inherit">inherited border</p><p style="border:foo">unknown border</p><p style="font-family:inherit">inherited family</p><p style="color:foo; padding:2px">independent padding</p>',
    ).then((result) => {
      const paragraphs = descendantElements(result.body, "p");
      expect(paragraphs.map((element) => attribute(element, "style"))).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        expect.stringContaining("padding"),
      ]);
      expect(styleDeclarations(attribute(paragraphs[8], "style") ?? "").get("padding")).toBe("2px");
      expect(styleDeclarations(attribute(paragraphs[8], "style") ?? "").has("color")).toBe(false);
    }));

  it("rejects important, resource functions, variables, expressions, and unclassified syntax", () =>
    sanitize(
      '<p style="color:red!important">important</p><p style="color:v\\61r(--sender-color)">var</p><p style="color:expression(alert(1))">expression</p><p style="color:url(https://tracker.test/x)">url</p><p style="color:rgb(0,0,0); broken-token">leftover</p>',
    ).then((result) => {
      expect(
        descendantElements(result.body, "p").every(
          (element) => attribute(element, "style") === undefined,
        ),
      ).toBe(true);
      expect(result.body).not.toContain("tracker.test");
    }));

  it("rejects imports and decoded CSS URL spellings without discarding independent presentation", () =>
    sanitize(
      '<p style="@import url(https://tracker.test/import); color:red">import</p><p style="background-image:u\\72l(https://tracker.test/pixel); color:blue">obfuscated</p><p style="font-family:u\\72l(https://tracker.test/font); padding:1px">resource</p>',
    ).then((result) => {
      const paragraphs = descendantElements(result.body, "p");
      expect(attribute(paragraphs[0], "style")).toBeUndefined();
      expect(styleDeclarations(attribute(paragraphs[1], "style") ?? "").get("color")).toBe("blue");
      expect(styleDeclarations(attribute(paragraphs[2], "style") ?? "").get("padding")).toBe("1px");
      expect(result.body).not.toContain("tracker.test");
      expect(result.body).not.toContain("url(");
    }));

  it("accepts exactly 8 KiB and rejects larger encoded declaration lists", () => {
    const boundary = `color:red;${" ".repeat(8182)}`;
    const oversized = `color:red;${" ".repeat(8192)}`;
    const multibyteOversized = `color:red;${"é".repeat(4092)}`;
    return sanitize(
      `<p style="${boundary}">boundary</p><p style="${oversized}">ascii</p><p style="${multibyteOversized}">multibyte</p>`,
    ).then((result) => {
      const paragraphs = descendantElements(result.body, "p");
      expect(styleDeclarations(attribute(paragraphs[0], "style") ?? "").get("color")).toBe("red");
      expect(attribute(paragraphs[1], "style")).toBeUndefined();
      expect(attribute(paragraphs[2], "style")).toBeUndefined();
    });
  });

  it("preserves only canonical credential-free absolute HTTPS anchors with forced defenses", () =>
    sanitize(
      '<a href=" HTTPS://Example.COM:443/a/../b?q=1&amp;x=2#frag" target="self" rel="opener" referrerpolicy="unsafe-url">safe</a><a href="https://user:pass@example.com/">credentials</a><a href="http://example.com/">http</a><a href="//example.com/path">relative</a><a href="mailto:user@example.com">mail</a><a href="javascript:alert(1)">script</a>',
    ).then((result) => {
      const anchors = descendantElements(result.body, "a");
      expect(anchors).toHaveLength(6);
      expect(attribute(anchors[0], "href")).toBe("https://example.com/b?q=1&x=2#frag");
      expect(attribute(anchors[0], "target")).toBe("_blank");
      expect(attribute(anchors[0], "rel")).toBe("noopener noreferrer nofollow");
      expect(attribute(anchors[0], "referrerpolicy")).toBe("no-referrer");
      for (const rejected of anchors.slice(1)) {
        expect(attribute(rejected, "href")).toBeUndefined();
        expect(attribute(rejected, "target")).toBeUndefined();
        expect(attribute(rejected, "rel")).toBeUndefined();
      }
    }));

  it("stores canonical HTTPS remote sources only as inert sanitizer-owned metadata", () =>
    sanitize(
      '<img alt="remote" src="HTTPS://Tracker.TEST:443/a/../pixel.png?m=1&amp;n=2"><img alt="http" src="http://tracker.test/pixel"><img alt="data" src="data:image/png;base64,AAAA"><img alt="blob" src="blob:https://tracker.test/id"><img alt="encoded" src="&#x68;ttps://tracker.test/encoded">',
    ).then((result) => {
      expect(result.hasRemoteImages).toBe(true);
      const images = descendantElements(result.body, "img");
      expect(images.map((element) => attribute(element, "alt"))).toEqual([
        "remote",
        "http",
        "data",
        "blob",
        "encoded",
      ]);
      expect(images.every((element) => attribute(element, "src") === undefined)).toBe(true);
      expect(attribute(images[0], "data-umail-remote-src")).toBe(
        "https://tracker.test/pixel.png?m=1&n=2",
      );
      expect(attribute(images[1], "data-umail-remote-src")).toBeUndefined();
      expect(attribute(images[2], "data-umail-remote-src")).toBeUndefined();
      expect(attribute(images[3], "data-umail-remote-src")).toBeUndefined();
      expect(attribute(images[4], "data-umail-remote-src")).toBe("https://tracker.test/encoded");
    }));

  it("strips caller-supplied remote metadata instead of treating it as sanitizer-owned", () =>
    sanitize(
      '<img alt="forged" data-umail-remote-src="https://tracker.test/forged" referrerpolicy="unsafe-url">',
    ).then((result) => {
      expect(result.hasRemoteImages).toBe(false);
      expect(attributeOf(result.body, "img", "alt")).toBe("forged");
      expect(attributeOf(result.body, "img", "data-umail-remote-src")).toBeUndefined();
      expect(attributeOf(result.body, "img", "src")).toBeUndefined();
      expect(attributeOf(result.body, "img", "referrerpolicy")).toBeUndefined();
    }));

  it("rewrites only unique safe-image CIDs to exact authenticated attachment paths", () => {
    const valid = attachment("att logo/1", "<Logo@UMail>", "IMAGE/PNG");
    const unsafe = attachment("unsafe", "vector@umail", "image/svg+xml");
    return sanitize(
      '<img alt="valid" src="CID:logo@umail"><img alt="unsafe" src="cid:vector@umail"><img alt="unknown" src="cid:missing@umail">',
      [valid, unsafe],
      "message/with space",
    ).then((result) => {
      const images = descendantElements(result.body, "img");
      expect(attribute(images[0], "src")).toBe(
        "/messages/message%2Fwith%20space/attachments/att%20logo%2F1",
      );
      expect(attribute(images[1], "src")).toBeUndefined();
      expect(attribute(images[2], "src")).toBeUndefined();
    });
  });

  it("drops ambiguous duplicate and empty CIDs", () =>
    sanitize('<img src="cid:LOGO@UMAIL"><img src="cid:">', [
      attachment("first", "<Logo@UMail>", "image/png"),
      attachment("second", "logo@umail", "image/jpeg"),
      attachment("empty", "<>", "image/png"),
    ]).then((result) => {
      const images = descendantElements(result.body, "img");
      expect(images).toHaveLength(2);
      expect(images.every((element) => attribute(element, "src") === undefined)).toBe(true);
    }));
});

describe("MailHtmlPolicy parser resource budgets", () => {
  it("accepts the UTF-8 input byte boundary and rejects one byte over it", () =>
    sanitize("x".repeat(MAIL_HTML_PARSE_LIMITS.inputBytes - 1))
      .then(() => sanitize("x".repeat(MAIL_HTML_PARSE_LIMITS.inputBytes)))
      .then(() =>
        expectResourceExhaustion(sanitize("x".repeat(MAIL_HTML_PARSE_LIMITS.inputBytes + 1))),
      )
      .then(() =>
        expectResourceExhaustion(sanitize("é".repeat(MAIL_HTML_PARSE_LIMITS.inputBytes / 2 + 1))),
      ));

  it("guards the exact parse5 allocation boundary and resets counters for each parse", () => {
    const fragmentScaffoldingNodes = 4;
    const atLimit = MAIL_HTML_PARSE_LIMITS.allocatedNodes - fragmentScaffoldingNodes;
    const policy = createMailHtmlPolicy();
    return sanitize("<br>".repeat(atLimit - 1))
      .then(() => sanitize("<br>".repeat(atLimit)))
      .then(() =>
        expectResourceExhaustion(
          Effect.runPromise(
            policy.sanitizeForStorage("<br>".repeat(atLimit + 1), {
              messageId: MESSAGE_ID,
              attachments: [],
            }),
          ),
        ),
      )
      .then(() =>
        Effect.runPromise(
          policy.sanitizeForStorage("<p>next parse</p>", {
            messageId: MESSAGE_ID,
            attachments: [],
          }),
        ),
      )
      .then((stored) => expect(stored.body).toBe("<p>next parse</p>"));
  });

  it("charges comment nodes at the exact allocation boundary", () => {
    const fragmentScaffoldingNodes = 4;
    const atLimit = MAIL_HTML_PARSE_LIMITS.allocatedNodes - fragmentScaffoldingNodes;
    const accepted = parseBoundedMailHtmlFragment("<!---->".repeat(atLimit));

    expect(accepted.childNodes).toHaveLength(atLimit);
    expect(
      resourceExhaustionFrom(() => parseBoundedMailHtmlFragment("<!---->".repeat(atLimit + 1)))
        .limit,
    ).toBe("allocated_nodes");
  });

  it("charges hidden text-node allocations between elements", () => {
    const fragmentScaffoldingNodes = 4;
    const nodesPerUnit = 2;
    const atLimit =
      (MAIL_HTML_PARSE_LIMITS.allocatedNodes - fragmentScaffoldingNodes) / nodesPerUnit;
    const accepted = parseBoundedMailHtmlFragment("<br>x".repeat(atLimit));

    expect(accepted.childNodes).toHaveLength(atLimit * nodesPerUnit);
    expect(
      resourceExhaustionFrom(() => parseBoundedMailHtmlFragment("<br>x".repeat(atLimit + 1))).limit,
    ).toBe("allocated_nodes");
  });

  it("bounds open elements and accepts a final tree exactly 128 nodes deep", () => {
    const sourceElementsAtOpenLimit = MAIL_HTML_PARSE_LIMITS.openElements - 1;
    const below = nestedElements(sourceElementsAtOpenLimit - 1, "text");
    const at = nestedElements(sourceElementsAtOpenLimit, "text");
    const over = nestedElements(sourceElementsAtOpenLimit + 1, "text");

    return sanitize(below)
      .then(() => sanitize(at))
      .then(() => expectResourceExhaustion(sanitize(over)));
  });

  it("bounds nested template content by final depth before the open-element limit", () => {
    const atLimit = MAIL_HTML_PARSE_LIMITS.finalTreeDepth / 2;
    const oneOver = atLimit + 1;
    expect(oneOver + 1).toBeLessThan(MAIL_HTML_PARSE_LIMITS.openElements);

    expect(() => parseBoundedMailHtmlFragment(nestedTemplates(atLimit))).not.toThrow();
    expect(
      resourceExhaustionFrom(() => parseBoundedMailHtmlFragment(nestedTemplates(oneOver))).limit,
    ).toBe("final_tree_depth");
  });

  it("enforces per-element attributes for parsed and adopted attributes", () => {
    const below = attributes(MAIL_HTML_PARSE_LIMITS.attributesPerElement - 1);
    const at = attributes(MAIL_HTML_PARSE_LIMITS.attributesPerElement);
    const over = attributes(MAIL_HTML_PARSE_LIMITS.attributesPerElement + 1);

    return sanitize(`<p ${below}>below</p>`)
      .then((stored) => expect(stored.body).toBe("<p>below</p>"))
      .then(() => sanitize(`<p ${at}>at</p>`))
      .then((stored) => expect(stored.body).toBe("<p>at</p>"))
      .then(() => expectResourceExhaustion(sanitize(`<p ${over}>over</p>`)))
      .then(() => sanitize(`<html ${at}><p>adopted</p></html>`))
      .then((stored) => expect(stored.body).toBe("<p>adopted</p>"))
      .then(() => expectResourceExhaustion(sanitize(`<html ${over}><p>adopted</p></html>`)));
  });

  it("bounds tokenizer attributes before tree construction without changing duplicate semantics", () => {
    const atLimit = attributes(MAIL_HTML_PARSE_LIMITS.attributesPerElement);
    expect(() => parseBoundedMailHtmlFragment(`<p ${atLimit} DATA-A0=second>`)).not.toThrow();
    expect(
      resourceExhaustionFrom(() =>
        parseBoundedMailHtmlFragment(
          `<p>body</p ${attributes(MAIL_HTML_PARSE_LIMITS.attributesPerElement + 1)}>`,
        ),
      ).limit,
    ).toBe("attributes_per_element");
    expect(
      resourceExhaustionFrom(() =>
        parseBoundedMailHtmlFragment(
          `<svg><g ${attributes(MAIL_HTML_PARSE_LIMITS.attributesPerElement + 1)}></g></svg>`,
        ),
      ).limit,
    ).toBe("attributes_per_element");
  });

  it("charges only attributes newly appended by parse5 adoption", () => {
    const repeatedDuplicate = "<html data-same=x>".repeat(
      MAIL_HTML_PARSE_LIMITS.admittedAttributes + 1,
    );
    return sanitize(`${repeatedDuplicate}<p>kept</p>`).then((stored) =>
      expect(stored.body).toBe("<p>kept</p>"),
    );
  });

  it("enforces the aggregate admitted-attribute boundary", () => {
    const fullElement = `<p ${attributes(MAIL_HTML_PARSE_LIMITS.attributesPerElement)}></p>`;
    const fullElements =
      MAIL_HTML_PARSE_LIMITS.admittedAttributes / MAIL_HTML_PARSE_LIMITS.attributesPerElement;
    const at = fullElement.repeat(fullElements);

    return sanitize(at.slice(0, -fullElement.length))
      .then(() => sanitize(at))
      .then(() => expectResourceExhaustion(sanitize(`${at}<p data-extra=x></p>`)));
  });

  it("keeps malformed formatting, foster parenting, templates, and foreign content safe", () => {
    const fixtures = [
      '<p><b title="b"><i title="i">one</b>two</i>end',
      "before<table>foster<tr><td>cell</td></tr></table>after",
      "<template><div>template content</div></template><p>outside</p>",
      "<svg><g><text>svg</text></g></svg><math><mi>x</mi></math><p>html</p>",
    ] as const;

    return Promise.all(
      fixtures.map((fixture) => sanitize(fixture).then((stored) => materialize(stored.body))),
    ).then((bodies) => expect(bodies).toHaveLength(fixtures.length));
  });

  it("charges elements cloned by the adoption-agency repair path", () => {
    const repairedFormattingUnit = '<b><i title="clone">x</b>y</i>';
    return sanitize(repairedFormattingUnit.repeat(3_999)).then(() =>
      expectResourceExhaustion(sanitize(repairedFormattingUnit.repeat(4_000))),
    );
  });

  it("rejects the 240,000-element amplification probe as resource exhaustion", () =>
    expectResourceExhaustion(sanitize("<b></b>".repeat(240_000))));

  it("accepts canonical output at the aggregate limit and materializes it", () => {
    const atCanonicalLimit = resourceExpandingAnchor().repeat(8_000);
    return sanitize(atCanonicalLimit).then((stored) => {
      expect(stored.body).toContain('rel="noopener noreferrer nofollow"');
      return expect(materialize(stored.body)).resolves.toContain("open");
    });
  });

  it("rejects sanitizer-generated attribute expansion before returning stored HTML", () =>
    expectResourceExhaustion(sanitize(resourceExpandingAnchor().repeat(9_300))));

  it("rejects sanitizer-generated canonical byte expansion before returning stored HTML", () => {
    const source = resourceExpandingAnchor("x".repeat(200)).repeat(6_000);
    expect(new TextEncoder().encode(source).byteLength).toBeLessThan(
      MAIL_HTML_PARSE_LIMITS.inputBytes,
    );
    return expectResourceExhaustion(sanitize(source));
  });
});

describe("MailHtmlPolicy remote image materializer", () => {
  it("re-sanitizes stored HTML before activating remote images", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['<p>safe</p><script src="https://tracker.test/active.js">run()</script>', "<p>safe</p>"],
      ["<p onclick=\"location.href='https://tracker.test/'\">click</p>", "<p>click</p>"],
      ['<img src="https://tracker.test/preexisting">', "<img>"],
      ['<img src="https://mail.umail.test/preexisting">', "<img>"],
      ['<img src="/messages/m/attachments/a">', "<img>"],
      ["<!--forged--><p>content</p>", "<p>content</p>"],
      ['<div data-forged="value">attribute</div>', "<div>attribute</div>"],
      [
        '<a href="https://example.test/">link</a>',
        '<a href="https://example.test/" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">link</a>',
      ],
      ['<p style="color: red; position: fixed">denied</p>', '<p style="color:red">denied</p>'],
      ['<p style="color:red!important">important</p>', "<p>important</p>"],
      ['<p style="color:var(--sender-color)">var</p>', "<p>var</p>"],
      ['<p style="color:expression(alert(1))">expression</p>', "<p>expression</p>"],
      [
        '<p style="background-image:url(https://tracker.test/pixel)">background</p>',
        "<p>background</p>",
      ],
      ['<img data-umail-remote-src="https://user:pass@tracker.test/pixel">', "<img>"],
      ['<img data-umail-remote-src="http://tracker.test/pixel">', "<img>"],
      ['<img data-umail-remote-src="javascript:alert(1)">', "<img>"],
    ];
    return Promise.all(cases.map(([body]) => materialize(body))).then((bodies) =>
      expect(bodies).toEqual(cases.map(([, expected]) => expected)),
    );
  });

  it("regenerates stored inline styles canonically", () =>
    Promise.all([
      materialize('<p style="color: red">spaced</p>'),
      materialize('<p style="color: red; padding: 2px">multi</p>'),
    ]).then((bodies) =>
      expect(bodies).toEqual([
        '<p style="color:red">spaced</p>',
        '<p style="color:red;padding:2px">multi</p>',
      ]),
    ));

  it("activates only cross-origin HTTPS metadata and sets no-referrer", () =>
    sanitize(
      '<img alt="cross" src="https://tracker.test/pixel?a=1&amp;b=2"><img alt="same" src="https://mail.umail.test/attacker"><img alt="http" src="http://tracker.test/pixel">',
    ).then((stored) =>
      materialize(stored.body).then((body) => {
        const images = descendantElements(body, "img");
        const cross = images.find((element) => attribute(element, "alt") === "cross");
        const same = images.find((element) => attribute(element, "alt") === "same");
        const http = images.find((element) => attribute(element, "alt") === "http");
        expect(attribute(cross, "data-umail-remote-src")).toBe(
          "https://tracker.test/pixel?a=1&b=2",
        );
        expect(attribute(cross, "src")).toBe("https://tracker.test/pixel?a=1&b=2");
        expect(attribute(cross, "referrerpolicy")).toBe("no-referrer");
        expect(attribute(same, "data-umail-remote-src")).toBe("https://mail.umail.test/attacker");
        expect(attribute(same, "src")).toBeUndefined();
        expect(attribute(http, "src")).toBeUndefined();
        expect(attribute(http, "data-umail-remote-src")).toBeUndefined();
      }),
    ));

  it("changes nothing but activated image attributes in a rich stored template", () =>
    sanitize(
      '<table style="border-collapse: collapse; width: 100%"><tr><td><a href="https://example.test/a/../destination">open</a><img alt="remote" src="https://tracker.test/pixel"></td></tr></table>',
    ).then((stored) =>
      materialize(stored.body).then((body) =>
        expect(body).toBe(
          stored.body.replace(
            'data-umail-remote-src="https://tracker.test/pixel"',
            'data-umail-remote-src="https://tracker.test/pixel" src="https://tracker.test/pixel" referrerpolicy="no-referrer"',
          ),
        ),
      ),
    ));
});

function sanitize(
  html: string,
  attachments: ReadonlyArray<MailHtmlAttachment> = [],
  messageId = MESSAGE_ID,
): Promise<StoredMailHtml> {
  return Effect.runPromise(
    createMailHtmlPolicy().sanitizeForStorage(html, { messageId, attachments }),
  );
}

function materialize(body: string): Promise<string> {
  return Effect.runPromise(
    createMailHtmlPolicy().materializeRemoteImages({ body, applicationUrl: APPLICATION_URL }),
  );
}

function expectResourceExhaustion(operation: Promise<StoredMailHtml>): Promise<void> {
  return expect(operation).rejects.toMatchObject({
    _tag: "MailHtmlPolicyError",
    reason: "resource_exhausted",
  });
}

function nestedElements(count: number, content: string): string {
  return `${"<div>".repeat(count)}${content}${"</div>".repeat(count)}`;
}

function nestedTemplates(count: number): string {
  return `${"<template>".repeat(count)}${"</template>".repeat(count)}`;
}

type MailHtmlParseOperation = () => ReturnType<typeof parseBoundedMailHtmlFragment>;

function resourceExhaustionFrom(operation: MailHtmlParseOperation): MailHtmlResourceExhaustion {
  try {
    operation();
  } catch (cause) {
    if (Schema.is(MailHtmlResourceExhaustion)(cause)) {
      return cause;
    }
    throw cause;
  }
  throw new Error("expected mail HTML resource exhaustion");
}

function attributes(count: number): string {
  return Array.from({ length: count }, (_, index) => `data-a${String(index)}=x`).join(" ");
}

function resourceExpandingAnchor(pathPrefix = ""): string {
  return `<a href="https://example.test/${pathPrefix}open" title="x" aria-hidden="true" aria-label="x" dir="ltr" lang="en" role="link">open</a>`;
}

function attachment(id: string, contentId: string, mimeType: string): MailHtmlAttachment {
  return { id, contentId, mimeType };
}

function isMailHtmlElement(node: MailHtmlNode): node is MailHtmlElement {
  return "tagName" in node;
}

function isMailHtmlText(node: MailHtmlNode): node is DefaultTreeAdapterMap["textNode"] {
  return node.nodeName === "#text";
}

function descendantElements(html: string, tagName?: string): MailHtmlElement[] {
  const found: MailHtmlElement[] = [];
  const visit = (nodes: ReadonlyArray<MailHtmlNode>) => {
    for (const node of nodes) {
      if (!isMailHtmlElement(node)) continue;
      if (tagName === undefined || node.tagName === tagName) found.push(node);
      visit(node.childNodes);
    }
  };
  visit(parseFragment(html).childNodes);
  return found;
}

function tags(html: string): string[] {
  return descendantElements(html).map((element) => element.tagName);
}

function attribute(element: MailHtmlElement | undefined, name: string): string | undefined {
  return element?.attrs.find((entry) => entry.name === name)?.value;
}

function attributeOf(html: string, tagName: string, name: string): string | undefined {
  return attribute(descendantElements(html, tagName)[0], name);
}

function textContent(element: MailHtmlElement): string {
  let text = "";
  for (const child of element.childNodes) {
    if (isMailHtmlText(child)) text += child.value;
    else if (isMailHtmlElement(child)) text += textContent(child);
  }
  return text;
}

function textOf(html: string, tagName: string): string {
  const element = descendantElements(html, tagName)[0];
  return element === undefined ? "" : textContent(element);
}

function texts(html: string, tagName: string): string[] {
  return descendantElements(html, tagName).map(textContent);
}

function styleDeclarations(style: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const part of style.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    declarations.set(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim());
  }
  return declarations;
}

function styleOf(html: string, tagName: string): Map<string, string> {
  return styleDeclarations(attributeOf(html, tagName, "style") ?? "");
}

function hasComment(html: string): boolean {
  const visit = (nodes: ReadonlyArray<MailHtmlNode>): boolean => {
    for (const node of nodes) {
      if (node.nodeName === "#comment") return true;
      if (isMailHtmlElement(node) && visit(node.childNodes)) return true;
    }
    return false;
  };
  return visit(parseFragment(html).childNodes);
}
