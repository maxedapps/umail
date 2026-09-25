import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { WebCrypto } from "../../src/crypto.ts";
import { htmlResponse, type PageKind } from "../../src/web/document.ts";
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
});
