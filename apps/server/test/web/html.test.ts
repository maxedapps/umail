import { describe, expect, it } from "@effect/vitest";

import {
  bidiAddress,
  bidiText,
  displayText,
  html,
  htmlText,
  initials,
  shortTimeHtml,
  utcDateTime,
} from "../../src/web/html.ts";

describe("html template", () => {
  it("escapes interpolated text, including quotes inside attributes", () => {
    const value = `<script>alert("x")</script> & 'y'`;
    const rendered = htmlText(html`<p title="${value}">${value}</p>`);

    expect(rendered).toBe(
      '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p>',
    );
  });

  it("passes nested Html and arrays of Html through without escaping them again", () => {
    const item = (label: string) => html`<li>${label}</li>`;
    const rendered = htmlText(
      html`<ul>
          ${["a & b", "<c>"].map(item)}
        </ul>
        ${false}${null}`,
    );

    expect(rendered.replace(/\s+/gu, "")).toBe("<ul><li>a&amp;b</li><li>&lt;c&gt;</li></ul>");
  });
});

describe("mail metadata display", () => {
  it("removes bidi formatting controls and visibly bounds line separators", () => {
    const display = displayText("؜Alice‎\r\n‮<admin>⁦@example.com‏\u0000\t");

    expect(display).toBe("Alice ⏎ <admin>@example.com");
  });

  it("removes every Unicode Bidi_Control character", () => {
    const bidiControls = "؜‎‏‪‫‬‭‮⁦⁧⁨⁩";

    expect(displayText(`left${bidiControls}right`)).toBe("leftright");
  });

  it("escapes and bidi-isolates display text and addresses separately", () => {
    expect(htmlText(bidiText('A <B> & "C"'))).toBe(
      '<bdi dir="auto">A &lt;B&gt; &amp; &quot;C&quot;</bdi>',
    );
    expect(htmlText(bidiAddress("attacker<alias>@example.com"))).toBe(
      '<bdi dir="ltr">attacker&lt;alias&gt;@example.com</bdi>',
    );
  });

  it("prints instants as fixed UTC text", () => {
    expect(utcDateTime("2026-09-24T08:05:00.000Z")).toBe("24 Sep 2026, 08:05 UTC");
  });

  it("marks list times for the short format and keeps the UTC fallback", () => {
    expect(htmlText(shortTimeHtml("2026-09-24T08:05:00.000Z"))).toBe(
      '<time datetime="2026-09-24T08:05:00.000Z" data-short>24 Sep 2026, 08:05 UTC</time>',
    );
  });
});

describe("avatar initials", () => {
  it.each([
    ["Anna Berg", "AB"],
    ["anna@example.com", "A"],
    ["Anna Maria Berg", "AM"],
    ["\u202e\u2066 -- ... \u2069", "?"],
  ])("gives %j the letters %j", (name, letters) => {
    expect(initials(name)).toBe(letters);
  });

  it("renders escaped when a name carries markup", () => {
    expect(htmlText(bidiText(initials("<b>Anna</b> Berg")))).toBe('<bdi dir="auto">BB</bdi>');
  });
});
