import { describe, expect, it } from "@effect/vitest";
import { Address } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { WebCrypto } from "../../src/crypto.ts";
import {
  htmlResponse,
  renderDocument,
  type PageKind,
  type PageView,
} from "../../src/web/document.ts";
import { html } from "../../src/web/html.ts";
import { loginPage } from "../../src/web/pages/login.ts";
import { readText } from "../api/world.ts";

const render = Effect.fn("render")(function* (kind: PageKind) {
  const response = HttpServerResponse.toWeb(
    yield* htmlResponse(200, {
      kind,
      title: "Page <title>",
      heading: "Heading",
      main: html`<p>Body</p>`,
      script: "document.title;",
    }),
  );
  const csp = response.headers.get("content-security-policy") ?? "";
  const nonce = /style-src 'nonce-([0-9a-f]{32})'/u.exec(csp)?.[1] ?? "";
  return { response, csp, nonce, body: yield* readText(response) };
}, Effect.provide(WebCrypto));

function cspRow(csp: string) {
  const directives = new Map(
    csp.split("; ").map((directive) => {
      const [name = "", ...values] = directive.split(" ");
      return [name, values.join(" ")] as const;
    }),
  );
  return {
    script: directives.get("script-src"),
    connect: directives.get("connect-src"),
    form: directives.get("form-action"),
    frame: directives.get("frame-src"),
  };
}

describe("document renderer", () => {
  it.effect.each([
    ["auth", "nonce", "'self'", "'self'", "'none'"],
    ["console", "nonce", "'none'", "'self'", "'self'"],
    ["form", "'none'", "'none'", "'self'", "'none'"],
    ["approval", "'none'", "'none'", "'self'", "'self'"],
    ["static", "'none'", "'none'", "'none'", "'none'"],
  ] as const)("gives %s pages exactly their CSP row", ([kind, script, connect, form, frame]) =>
    Effect.gen(function* () {
      const { csp, nonce, body } = yield* render(kind);

      expect(cspRow(csp)).toEqual({
        script: script === "nonce" ? `'nonce-${nonce}'` : script,
        connect,
        form,
        frame,
      });
      for (const fixed of [
        "default-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        `style-src 'nonce-${nonce}'`,
        "style-src-attr 'none'",
      ]) {
        expect(csp).toContain(fixed);
      }
      expect(body).toContain(`<style nonce="${nonce}">`);
      expect(body.includes(`<script nonce="${nonce}">`)).toBe(script === "nonce");
      expect(body.match(/<\/body>/gu)).toHaveLength(1);
      if (script === "nonce") expect(body.indexOf("<script")).toBeLessThan(body.indexOf("</body>"));
      expect(body).toContain("<title>Page &lt;title&gt; · AgentMail</title>");
    }),
  );

  it.effect("uses a fresh nonce per render and private, unframeable headers", () =>
    Effect.gen(function* () {
      const first = yield* render("static");
      const second = yield* render("static");

      expect(first.nonce).toMatch(/^[0-9a-f]{32}$/u);
      expect(second.nonce).not.toBe(first.nonce);
      expect(first.response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(first.response.headers.get("x-frame-options")).toBe("DENY");
      expect(first.response.headers.get("cache-control")).toBe("no-store");
      expect(first.response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
      expect(first.body).toContain('name="robots" content="noindex,nofollow,noarchive"');
      expect(first.body).not.toMatch(/style="/u);
    }),
  );

  it.effect("keeps credentials out of the URL when the login script cannot run", () =>
    Effect.gen(function* () {
      const response = HttpServerResponse.toWeb(yield* htmlResponse(200, loginPage()));
      const body = yield* readText(response);
      const formTag = /<form\s[^>]*id="login-form"[^>]*>/u.exec(body)?.[0] ?? "";

      expect(formTag).toContain('method="post"');
      expect(formTag).toContain('action="/api/auth/sign-in/email"');
      expect(body).toContain('<label for="secret">Password</label>');
    }).pipe(Effect.provide(WebCrypto)),
  );

  it("marks the console section and nests the mailboxes under Mail only on mail pages", () => {
    const addresses = [
      ["box-1", "support"],
      ["box-2", "hello"],
    ].map(
      ([id = "", localPart = ""]) =>
        new Address({
          id,
          localPart,
          address: `${localPart}@example.com`,
          displayName: null,
          active: true,
          forwardTo: null,
          createdAt: "2026-09-25T00:00:00.000Z",
          updatedAt: "2026-09-25T00:00:00.000Z",
        }),
    );
    const mail = consolePage({ section: "mail", mailboxes: { addresses, current: "box-2" } });
    const clients = consolePage({ section: "clients" });

    expect(mail).toMatch(/<a href="\/mail" aria-current="true"/u);
    expect(mail).toContain('class="subnav"');
    expect(mail).toMatch(/aria-current="page">\s*<span class="mono">hello@example\.com/u);
    expect(mail).toMatch(/aria-current="false">\s*<span class="mono">support@example\.com/u);
    expect(clients).not.toContain('class="subnav"');
    expect(clients).toMatch(/<a href="\/clients" aria-current="page"/u);
    expect(clients).toMatch(/<a href="\/mail" aria-current="false"/u);
  });

  it("shows a success as a toast and keeps an error inline", () => {
    const success = consolePage({ flash: { tone: "success", message: "Saved." } });
    const error = consolePage({ flash: { tone: "error", message: "Nothing was saved." } });

    expect(success).toMatch(/<p class="toast" role="status">.*Saved\.<\/p>/su);
    expect(success).not.toContain('role="alert"');
    expect(error).toMatch(/<p class="flash" role="alert">.*Nothing was saved\.<\/p>/su);
    expect(error).not.toContain('class="toast"');
  });

  it.each([
    ["approval", 'class="focus-bar"', 'class="column"'],
    ["auth", 'class="card"', "<header><svg"],
    ["static", 'class="card"', "<header><svg"],
  ] as const)("renders %s pages in their focus layout", (kind, first, second) => {
    const body = renderDocument({ ...PAGE, kind }, "0".repeat(32));

    expect(body).toContain('<body class="focus">');
    expect(body).toContain(first);
    expect(body.replace(/\s+/gu, "")).toContain(second.replace(/\s+/gu, ""));
  });

  it.each(["console", "approval", "auth"] as const)(
    "hides every %s icon from assistive technology and writes no inline style",
    (kind) => {
      const body = renderDocument(
        { ...PAGE, kind, flash: { tone: "error", message: "Failed." } },
        "0".repeat(32),
      );
      const svgs = body.match(/<svg[^>]*>/gu) ?? [];

      expect(svgs.length).toBeGreaterThan(0);
      for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
      expect(body).not.toMatch(/style="/u);
    },
  );
});

const PAGE: PageView = {
  kind: "console",
  title: "Page",
  heading: "Heading",
  main: html`<p>Body</p>`,
};

function consolePage(view: Partial<PageView>): string {
  return renderDocument({ ...PAGE, section: "mail", ...view }, "0".repeat(32));
}
