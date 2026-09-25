import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ExternalMailAddress, requireApprovalSendMode } from "@umail/api-contract";

import {
  projectApprovalDecisionMetadata,
  renderApprovalDecisionAddress,
  renderApprovalDecisionText,
} from "../../src/api/human-pages/metadata.ts";
import { renderClientsPage } from "../../src/api/human-pages/oauth-management.ts";
import { renderHumanPageNotice } from "../../src/api/human-pages/notices.ts";
import {
  humanPageHttpApiResponse,
  humanPageHttpResponse,
} from "../../src/api/human-pages/response.ts";

function notice(status: 200 | 404 | 410) {
  return renderHumanPageNotice({
    status,
    title: `Ledger <${status}> & private`,
    eyebrow: "Approval review",
    heading: `Status ${status} <script>`,
    description: "A private & escaped status document.",
    message: 'Nothing here can become <img src=x onerror="alert(1)"> markup.',
    tone: status === 200 ? "ordinary" : "error",
  });
}

function directives(csp: string) {
  const entries = csp.split(";").map((directive) => {
    const [name, ...values] = directive.trim().split(/\s+/u);
    return [name, values.join(" ")] as const;
  });
  return new Map(entries);
}

describe("human page rendering", () => {
  it.effect.each([200, 404, 410] as const)(
    "renders a private semantic HTML response with status %s",
    (status) =>
      Effect.gen(function* () {
        const page = notice(status);
        const response = HttpServerResponse.toWeb(humanPageHttpResponse(page));
        const html = yield* Effect.promise(() => response.text());

        expect(response.status).toBe(status);
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("x-frame-options")).toBe("DENY");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
        expect(response.headers.get("permissions-policy")).toContain("camera=()");
        expect(html).toContain('<html lang="en">');
        expect(html).toContain('<meta charset="utf-8">');
        expect(html).toContain('name="viewport"');
        expect(html).toContain('name="robots" content="noindex,nofollow,noarchive"');
        expect(html).toContain('<main class="page-shell">');
        expect(html).toContain('class="wordmark"');
        expect(html).toContain('aria-label="AgentMail"');
        expect(html).toContain(">AM</span>");
        expect(html).toContain("AgentMail · API / CLI / MCP first");
        expect(html).not.toContain("Umail");
        expect(html.match(/<style\s/gu) ?? []).toHaveLength(1);
        expect(html).toContain(`style nonce="${page.nonce}"`);
        expect(html).toContain(`Ledger &lt;${status}&gt; &amp; private`);
        expect(html).toContain(`Status ${status} &lt;script&gt;`);
        expect(html).toContain(
          "Nothing here can become &lt;img src=x onerror=&quot;alert(1)&quot;&gt; markup.",
        );
        expect(html).not.toContain('<img src=x onerror="alert(1)">');
        expect(html).not.toMatch(/https?:\/\//u);
        expect(html).not.toContain("@font-face");

        const csp = directives(response.headers.get("content-security-policy") ?? "");
        expect(csp.get("default-src")).toBe("'none'");
        expect(csp.get("base-uri")).toBe("'none'");
        expect(csp.get("frame-ancestors")).toBe("'none'");
        expect(csp.get("script-src")).toBe("'none'");
        expect(csp.get("connect-src")).toBe("'none'");
        expect(csp.get("form-action")).toBe("'none'");
        expect(csp.get("frame-src")).toBe("'none'");
        expect(csp.get("style-src")).toBe(`'nonce-${page.nonce}'`);
        expect(csp.get("style-src-attr")).toBe("'none'");
      }),
  );

  it("uses the same body and policy headers for typed HttpApi responses", () => {
    const page = notice(410);
    const typed = humanPageHttpApiResponse(page);

    expect(typed.body).toBe(page.html);
    expect(typed.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(typed.headers["content-security-policy"]).toContain(`style-src 'nonce-${page.nonce}'`);
  });
});

describe("client access controls", () => {
  it("labels every policy control per client and offers revoke on every row", () => {
    const page = renderClientsPage([
      {
        clientId: "client-a",
        name: "Alpha <agent>",
        consentId: "consent-a",
        policy: {
          mailboxIds: "all",
          canRead: true,
          sendMode: requireApprovalSendMode(),
          recipientAllowlist: "any",
        },
      },
      {
        clientId: "client-b",
        name: null,
        consentId: "consent-b",
        policy: {
          mailboxIds: ["box-1"],
          canRead: false,
          sendMode: { kind: "allow" },
          recipientAllowlist: [Schema.decodeSync(ExternalMailAddress)("allowed@example.com")],
        },
      },
      { clientId: "client-c", name: null, consentId: "consent-c", policy: null },
      { clientId: "umail-cli", name: "AgentMail CLI", consentId: null, policy: null },
    ]);
    for (const id of ["client-a", "client-b", "client-c"]) {
      for (const field of ["mailboxes", "sendMode", "preapproved", "recipients"]) {
        expect(page.html).toContain(`for="${field}-${id}"`);
      }
      expect(page.html).toContain(`id="canRead-${id}"`);
    }
    expect(page.html).toContain("Alpha &lt;agent&gt;");
    expect(page.html).toContain('action="/clients/consent-a/policy"');
    expect(page.html).toContain("No access until a policy is saved");
    expect(page.html).not.toContain("/clients/umail-cli/policy");
    expect(page.html).toContain('action="/clients/umail-cli/revoke"');
    expect(page.html.match(/Revoke access/gu)).toHaveLength(4);
  });
});

describe("approval decision metadata presentation", () => {
  it("removes bidi formatting controls and visibly bounds line separators", () => {
    const display = projectApprovalDecisionMetadata(
      "\u061cAlice\u200e\r\n\u202e<admin>\u2066@example.com\u200f\u0000\t",
    );

    expect(display.value).toBe("Alice ⏎ <admin>@example.com");
    expect(display.value).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(display.value).not.toContain("\n");
  });

  it("removes every Unicode Bidi_Control character", () => {
    const bidiControls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";

    expect(projectApprovalDecisionMetadata(`left${bidiControls}right`).value).toBe("leftright");
  });

  it("escapes and bidi-isolates display text and addresses separately", () => {
    const displayName = renderApprovalDecisionText(projectApprovalDecisionMetadata('A <B> & "C"'));
    const address = renderApprovalDecisionAddress(
      projectApprovalDecisionMetadata("attacker<alias>@example.com"),
    );

    expect(displayName.html).toBe('<bdi dir="auto">A &lt;B&gt; &amp; &quot;C&quot;</bdi>');
    expect(address.html).toBe('<bdi dir="ltr">attacker&lt;alias&gt;@example.com</bdi>');
  });
});
