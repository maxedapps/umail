import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { describe, expect, it } from "vitest";

import { consentPageResponse, loginPageResponse } from "../../src/api/human-pages/auth.ts";
import { makeAuthOptions } from "../../src/auth/options.ts";
import { OPERATOR_PASSWORD, TEST_SITE, createWorld } from "./world.ts";

async function responseHtml(response: HttpServerResponse.HttpServerResponse) {
  const webResponse = HttpServerResponse.toWeb(response);
  return { response: webResponse, html: await webResponse.text() };
}

function nonceFromCsp(response: Response) {
  const csp = response.headers.get("content-security-policy") ?? "";
  const match = /script-src 'nonce-([0-9a-f]{32})'/u.exec(csp);
  if (match === null || match[1] === undefined) {
    throw new Error("auth page CSP did not contain a valid script nonce");
  }
  return match[1];
}

describe("auth HTML pages", () => {
  it("renders a secure, labelled login flow through the existing Better Auth endpoints", async () => {
    const { response, html } = await responseHtml(loginPageResponse());
    const nonce = nonceFromCsp(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(response.headers.get("content-security-policy")).toContain(`style-src 'nonce-${nonce}'`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(
      '<form class="auth-form" id="login-form" method="post" action="/api/auth/sign-in/email"',
    );
    expect(html).toContain("Operator sign in · AgentMail");
    expect(html).toContain('<label class="field__label" for="email">Operator email</label>');
    expect(html).toContain('<label class="field__label" for="secret">Operator secret</label>');
    expect(html).toContain('name="password" type="password" autocomplete="current-password"');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).not.toContain(OPERATOR_PASSWORD);
  });

  it("keeps credentials out of the URL when the login script cannot run", async () => {
    const { html } = await responseHtml(loginPageResponse());
    const formTag = /<form\s[^>]*id="login-form"[^>]*>/u.exec(html)?.[0] ?? "";

    expect(formTag).toContain('method="post"');
    expect(formTag).toContain('action="/api/auth/sign-in/email"');
    expect(formTag).not.toContain('method="get"');
    expect(formTag).not.toContain("?");
  });

  it("renders semantic consent controls while preserving the OAuth query and endpoint", async () => {
    const { response, html } = await responseHtml(consentPageResponse());
    const nonce = nonceFromCsp(response);

    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('<dl class="consent-details">');
    expect(html).toContain('<bdi id="client-id" dir="auto"></bdi>');
    expect(html).toContain('<bdi id="scope" dir="auto"></bdi>');
    expect(html).toContain("<dt>Redirects to</dt>");
    expect(html).toContain('<bdi id="redirect-host" dir="auto"></bdi>');
    expect(html).toContain('<button id="accept" type="button">Allow access</button>');
    expect(html).toContain('id="deny" type="button">Deny request</button>');
    expect(html).toContain('<input id="mailboxes" name="mailboxes" type="text" value="all"');
    expect(html).toContain('<option value="requireApproval" selected>');
  });

  it("serves the styled pages from the existing GET routes", async () => {
    const world = await createWorld();
    const login = await world.fetch("http://umail.test/login?oauth_request=preserved");
    const consent = await world.fetch(
      "http://umail.test/consent?client_id=client-1&scope=openid%20offline_access",
    );

    expect(login.status).toBe(200);
    expect(await login.text()).toContain('id="login-form"');
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain('id="consent-form"');
  });

  it("keeps the production Better Auth rate limiter enabled", () => {
    const options = makeAuthOptions(TEST_SITE, "operator-id", { rateLimit: true });

    expect(options.rateLimit).toEqual({ enabled: true, storage: "database" });
    expect(options.basePath).toBe("/api/auth");
  });
});
