import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMailHtmlPolicy,
  type MailHtmlAttachment,
  type StoredMailHtml,
} from "../src/index.ts";

const MESSAGE_ID = "in_browser_semantics";
const APPLICATION_URL = new URL("https://mail.umail.test/inbox");
const TRACKER = "https://tracker.umail-semantics.test";
const FORBIDDEN_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "form",
  "link",
];

const hosts: HTMLElement[] = [];

describe("mail-content browser program", () => {
  it("imports the public package without running the sanitizer", () => {
    expect(createMailHtmlPolicy).toEqual(expect.any(Function));
  });
});

describe("mail HTML browser semantics", () => {
  afterEach(() => {
    for (const host of hosts) host.remove();
    hosts.length = 0;
  });

  it("preserves quoted font families without creating forbidden CSS resources", () =>
    sanitize(
      `<p style='font-family: "Times New Roman", Georgia, serif; color: navy'>Quoted</p>`,
    ).then((stored) => {
      const host = mount(stored.body);
      const paragraph = host.querySelector("p");
      expect(paragraph).not.toBeNull();
      if (paragraph === null) return;
      expect(paragraph.style.fontFamily).toMatch(/Times New Roman/u);
      expect(getComputedStyle(paragraph).backgroundImage).toBe("none");
      expectForbiddenResources(host);
      expect(resourceUrls()).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/tracker/u)]),
      );
    }));

  it("decodes named and numeric entity quotes into sanitizer-owned values", () =>
    sanitize(
      `<a title="&quot;named&quot;" href="https://example.test/?q=&quot;x&quot;">named</a><img alt="&#34;numeric&#34;" src="&#x68;ttps://tracker.umail-semantics.test/encoded">`,
    ).then((stored) => {
      expect(stored.hasRemoteImages).toBe(true);
      const host = mount(stored.body);
      const anchor = host.querySelector("a");
      const image = host.querySelector("img");
      expect(anchor?.title).toBe('"named"');
      expect(anchor?.getAttribute("href")).toContain("%22x%22");
      expect(image).toBeInstanceOf(HTMLImageElement);
      if (!(image instanceof HTMLImageElement)) return;
      expect(image.alt).toBe('"numeric"');
      expect(image.getAttribute("src")).toBeNull();
      expect(image.getAttribute("data-umail-remote-src")).toBe(`${TRACKER}/encoded`);
      expect(image.currentSrc).toBe("");
      expectForbiddenResources(host);
    }));

  it("removes namespaced and malformed hostile markup instead of leaking nested content", () =>
    sanitize(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><p>svg-secret</p></svg><math><p>math-secret</p></math><custom-element><p>custom-secret</p></custom-element><p title="ok"><b>bold<img src="javascript:alert(1)"><script>bad`,
    ).then((stored) => {
      const host = mount(stored.body);
      expect(host.querySelector("svg")).toBeNull();
      expect(host.querySelector("math")).toBeNull();
      expect(host.querySelector("custom-element")).toBeNull();
      expect(host.querySelector("script")).toBeNull();
      expect(host.textContent).not.toContain("custom-secret");
      expect(host.textContent).not.toContain("bad");
      expect(host.textContent).toContain("svg-secret");
      expect(host.textContent).toContain("math-secret");
      expect(host.querySelector('p[title="ok"]')?.getAttribute("title")).toBe("ok");
      expect(host.querySelector("img")?.getAttribute("src")).toBeNull();
      expectForbiddenResources(host);
    }));

  it("drops ambiguous CIDs and rewrites only a unique safe image", () =>
    sanitize(
      '<img alt="unique" src="cid:logo@umail"><img alt="dup" src="cid:dup@umail"><img alt="missing" src="cid:missing@umail">',
      [
        attachment("att_logo", "logo@umail", "image/png"),
        attachment("first", "dup@umail", "image/jpeg"),
        attachment("second", "<Dup@UMail>", "image/png"),
      ],
    ).then((stored) => {
      const host = mount(stored.body);
      const unique = host.querySelector('img[alt="unique"]');
      const duplicate = host.querySelector('img[alt="dup"]');
      const missing = host.querySelector('img[alt="missing"]');
      expect(unique?.getAttribute("src")).toBe(`/messages/${MESSAGE_ID}/attachments/att_logo`);
      expect(duplicate?.getAttribute("src")).toBeNull();
      expect(missing?.getAttribute("src")).toBeNull();
      expectForbiddenResources(host);
    }));

  it("keeps stored remote previews network-inert until activation", () =>
    sanitize(
      `<img alt="remote" src="${TRACKER}/pixel.png"><img alt="http" src="http://tracker.umail-semantics.test/pixel">`,
    ).then((stored) => {
      expect(stored.hasRemoteImages).toBe(true);
      const preview = mount(stored.body);
      const remote = preview.querySelector('img[alt="remote"]');
      expect(remote).toBeInstanceOf(HTMLImageElement);
      if (!(remote instanceof HTMLImageElement)) return Promise.resolve();
      expect(remote.getAttribute("src")).toBeNull();
      expect(remote.getAttribute("data-umail-remote-src")).toBe(`${TRACKER}/pixel.png`);
      expect(remote.currentSrc).toBe("");
      expect(resourceUrls().some((url) => url.includes("tracker.umail-semantics.test"))).toBe(
        false,
      );
      return materialize(stored.body).then((activated) => {
        const revealed = mount(activated);
        const revealedRemote = revealed.querySelector('img[alt="remote"]');
        const revealedHttp = revealed.querySelector('img[alt="http"]');
        expect(revealedRemote?.getAttribute("src")).toBe(`${TRACKER}/pixel.png`);
        expect(revealedRemote?.getAttribute("referrerpolicy")).toBe("no-referrer");
        expect(revealedHttp?.getAttribute("src")).toBeNull();
        expectForbiddenResources(preview);
        expectForbiddenResources(revealed);
      });
    }));

  it("renders a benign rich template without browser-created forbidden CSS or tags", () =>
    sanitize(
      `<table style="border-collapse: collapse; width: 100%"><tr><td style="font-family: &quot;Courier New&quot;, monospace; padding: 8px"><a href="https://example.test/a/../inbox">Open</a><img alt="cid" src="cid:logo@umail"><img alt="remote" src="${TRACKER}/pixel.png"></td></tr></table>`,
      [attachment("att_logo", "logo@umail", "image/png")],
    ).then((stored) => {
      const host = mount(stored.body);
      const cell = host.querySelector("td");
      expect(cell).not.toBeNull();
      if (cell === null) return;
      expect(cell.style.fontFamily).toMatch(/Courier New/u);
      expect(getComputedStyle(cell).backgroundImage).toBe("none");
      expect(host.querySelector("a")?.getAttribute("href")).toBe("https://example.test/inbox");
      expect(host.querySelector('img[alt="cid"]')?.getAttribute("src")).toBe(
        `/messages/${MESSAGE_ID}/attachments/att_logo`,
      );
      expect(host.querySelector('img[alt="remote"]')?.getAttribute("src")).toBeNull();
      expectForbiddenResources(host);
      expect(resourceUrls().some((url) => url.includes("tracker.umail-semantics.test"))).toBe(
        false,
      );
    }));
});

function sanitize(
  html: string,
  attachments: ReadonlyArray<MailHtmlAttachment> = [],
): Promise<StoredMailHtml> {
  return Effect.runPromise(
    createMailHtmlPolicy().sanitizeForStorage(html, { messageId: MESSAGE_ID, attachments }),
  );
}

function materialize(body: string): Promise<string> {
  return Effect.runPromise(
    createMailHtmlPolicy().materializeRemoteImages({ body, applicationUrl: APPLICATION_URL }),
  );
}

function attachment(id: string, contentId: string, mimeType: string): MailHtmlAttachment {
  return { id, contentId, mimeType };
}

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  hosts.push(host);
  return host;
}

function expectForbiddenResources(host: HTMLElement): void {
  for (const tag of FORBIDDEN_TAGS) {
    expect(host.querySelector(tag)).toBeNull();
  }
  for (const element of host.querySelectorAll<HTMLElement>("*")) {
    expect(getComputedStyle(element).backgroundImage).toBe("none");
    expect(element.getAttribute("srcdoc")).toBeNull();
    expect(element.getAttribute("srcset")).toBeNull();
  }
}

function resourceUrls(): string[] {
  return performance.getEntriesByType("resource").map((entry) => entry.name);
}
