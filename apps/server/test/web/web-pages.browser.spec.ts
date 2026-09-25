import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { commands } from "vitest/browser";

import {
  WebPageBrowserObservation as WebPageBrowserObservationSchema,
  WebPageBrowserVisit,
  type WebPageBrowserFixture,
  type WebPageBrowserObservation,
} from "./web-pages-browser-model.ts";

const PREVIEW_CSP =
  "default-src 'none'; sandbox; frame-ancestors 'self'; script-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; style-src-elem 'none'; style-src-attr 'unsafe-inline'";

describe("web pages in Chromium", () => {
  it.effect(
    "executes the nonce-authorized login and consent scripts through their first-party endpoints",
    () =>
      Effect.gen(function* () {
        const consent = yield* observe("consent");
        const login = yield* observe("login");

        expect(login.status).toBe(200);
        expect(login.contentType).toBe("text/html; charset=utf-8");
        expect(login.frameOptions).toBe("DENY");
        expect(login.scriptNonce).toBe(cspScriptNonce(login.contentSecurityPolicy));
        expect(login.keyboardFocusId).toBe("secret");
        expect(login.focusOutlineStyle).not.toBe("none");
        expect(login.focusOutlineWidth).not.toBe("0px");
        expect(login.controlHeight).toBeGreaterThanOrEqual(44);
        expect(login.authRequestPath).toBe("/api/auth/sign-in/email");
        expect(login.authRequestMethod).toBe("POST");
        expect(login.finalPath).toBe("/mail");
        expect(login.bodyText).not.toContain("First time here");
        expect(login.authRequestBody).not.toContain("oauth_query");
        expect(cspViolations(login)).toEqual([]);

        expect(consent.scriptNonce).toBe(cspScriptNonce(consent.contentSecurityPolicy));
        expect(consent.heading).toBe("Allow Browser consent to use AgentMail?");
        expect(consent.bodyText).toContain("Use your mailboxes · stay signed in");
        expect(consent.bodyText).toContain("http://127.0.0.1");
        expect(consent.keyboardFocusId).toBe("deny");
        expect(consent.buttons).toEqual([
          { name: "Allow access", type: "button", formAction: "" },
          { name: "Deny", type: "button", formAction: "" },
        ]);
        expect(consent.authRequestPath).toBe("/api/auth/oauth2/consent");
        expect(consent.authRequestMethod).toBe("POST");
        expect(consent.authRequestBody).toContain("oauth_query");
        expect(consent.authRequestBody).toContain("client_id");
        expect(consent.authRequestBody).toContain('"mailboxes":"all"');
        expect(consent.authRequestBody).toContain('"sendMode":"requireApproval"');
        expect(consent.hostileElementCount).toBe(0);
        expect(cspViolations(consent)).toEqual([]);
      }),
  );

  it.effect("reveals policy fields with :has() and opens the revoke popover by keyboard", () =>
    Effect.gen(function* () {
      const client = yield* observe("client");

      expect(client.status).toBe(200);
      expect(client.preapprovedShownWithApproval).toBe(true);
      expect(client.preapprovedShownWhenNever).toBe(false);
      expect(client.revokePopoverOpen).toBe(true);
      expect(cspViolations(client)).toEqual([]);
    }),
  );

  it.effect("shows a conversation with a loadless body frame, local times and inert metadata", () =>
    Effect.gen(function* () {
      const thread = yield* observe("mail-thread");

      expect(thread.status).toBe(200);
      // Inline images stay blocked in the frame and are listed as attachments instead.
      expect(thread.frameImageWidth).toBe(0);
      expect(thread.bodyText).toContain("logo.png");
      expect(thread.firstTimeText).not.toBeNull();
      expect(thread.firstTimeText).not.toContain("UTC");
      expect(thread.heading).toContain("<script data-hostile-subject>subject</script>");
      expect(thread.hostileElementCount).toBe(0);
      // The only report is the frame refusing that image.
      expect(cspViolations(thread)).toEqual([
        expect.stringMatching(/image .*violates .*"img-src 'none'"/u),
      ]);
    }),
  );

  it.effect(
    "keeps hostile approval metadata inert and exposes one keyboard-usable native decision form",
    () =>
      Effect.gen(function* () {
        const pending = yield* observe("pending");

        expect(pending.formCount).toBe(1);
        expect(pending.formMethod).toBe("post");
        expect(pending.formAction).toBeNull();
        expect(pending.buttons).toHaveLength(2);
        expect(pending.buttons[0]).toEqual({
          name: "Approve & send",
          type: "submit",
          formAction: expect.stringMatching(/^\/approvals\/[0-9a-f]{64}\/approve$/u),
        });
        expect(pending.buttons[1]).toEqual({
          name: "Deny request",
          type: "submit",
          formAction: expect.stringMatching(/^\/approvals\/[0-9a-f]{64}\/deny$/u),
        });
        expect(pending.keyboardFocusId).toBeNull();
        expect(pending.keyboardFocusText).toBe("Deny request");
        expect(pending.focusOutlineStyle).not.toBe("none");
        expect(pending.focusOutlineWidth).not.toBe("0px");
        expect(pending.controlHeight).toBeGreaterThanOrEqual(44);
        expect(pending.metadataText).toContain("⏎");
        expect(pending.metadataText).toContain("<script data-hostile-subject>subject</script>");
        expect(pending.metadataBidiControlCount).toBe(0);
        expect(pending.hostileElementCount).toBe(0);
        expect(pending.automaticIsolationCount).toBeGreaterThanOrEqual(5);
        expect(pending.addressIsolationCount).toBe(4);
        expect(pending.sectionsSeparated).toBe(true);
        expect(cspViolations(pending)).toEqual([]);
      }),
  );

  it.effect(
    "keeps the stored HTML preview inside an empty sandbox with its exact response policy",
    () =>
      Effect.gen(function* () {
        const pending = yield* observe("pending");

        expect(pending.bodyText).toContain("This message contains remote images.");
        expect(pending.iframeSandbox).toBe("");
        expect(pending.previewContentSecurityPolicy).toBe(PREVIEW_CSP);
        expect(pending.previewFrameOptions).toBeNull();
        expect(pending.previewBodyText).toContain("Canonical stored preview");
        expect(pending.previewBodyText).toContain("External destination");
        expect(pending.previewUrlAfterActivation).toBe(pending.previewUrlBeforeActivation);
        expect(pending.externalRequests).toEqual([]);
        expect(pending.openedPageCount).toBe(0);
        expect(pending.consoleMessages.some(isSandboxPopupDenial)).toBe(true);
        expect(cspViolations(pending)).toEqual([]);
      }),
  );

  it.effect.each([
    ["accepted", 200, "accepted by Cloudflare for delivery"],
    ["failed", 200, "Cloudflare rejected it (E_RECIPIENT_SUPPRESSED)"],
    ["queued", 200, "AgentMail is sending this email now"],
    ["denied", 200, "The email was not sent"],
    ["expired", 410, "no longer available"],
    ["unknown", 404, "was not found"],
  ] as const)("renders %s as an action-free terminal page", ([fixture, status, expectedMeaning]) =>
    Effect.gen(function* () {
      const terminal = yield* observe(fixture);

      expect(terminal.status).toBe(status);
      expect(terminal.bodyText).toContain(expectedMeaning);
      expect(terminal.formCount).toBe(0);
      expect(terminal.buttons).toEqual([]);
      expect(cspViolations(terminal)).toEqual([]);
    }),
  );

  it.effect("returns to console paths after sign-in and ignores hostile destinations", () =>
    Effect.gen(function* () {
      for (const next of ["/clients", "/mail/threads/x?open=m1", "/mailboxes/box-1", "/device"]) {
        const returned = yield* observe("login", {
          width: 1280,
          height: 900,
          colorScheme: "light",
          search: new URLSearchParams({ next }).toString(),
        });
        expect(returned.authRequestPath).toBe("/api/auth/sign-in/email");
        expect(returned.authRequestBody).not.toContain("oauth_query");
        expect(returned.authRequestBody).toContain("approver@example.com");
        expect(returned.finalPath).toBe(new URL(next, "https://umail.test").pathname);
      }

      for (const next of [
        "https://evil.example/callback",
        "//evil.example",
        "/\\evil.example",
        "/login",
        "/mailbox",
        "/mail.evil",
      ]) {
        const hostile = yield* observe("login", {
          width: 1280,
          height: 900,
          colorScheme: "light",
          search: new URLSearchParams({ next }).toString(),
        });
        expect(hostile.finalPath).toBe("/mail");
        expect(hostile.authRequestBody).not.toContain("oauth_query");
      }
    }),
  );

  it.effect("sends only a signed OAuth continuation query from the login page", () =>
    Effect.gen(function* () {
      const login = yield* observe("login", {
        width: 1280,
        height: 900,
        colorScheme: "light",
        search:
          "client_id=cursor&redirect_uri=https%3A%2F%2Fwww.cursor.com%2Fagents%2Fmcp%2Foauth%2Fcallback&sig=test-signature&ba_param=client_id&ba_param=redirect_uri&ba_param=sig&ba_param=ba_param&foo=unsigned",
      });
      expect(login.authRequestBody).toContain("oauth_query");
      expect(login.authRequestBody).toContain("sig=test-signature");
      expect(login.authRequestBody).not.toContain("foo=unsigned");
      expect(login.authRequestPath).toBe("/api/auth/sign-in/email");
    }),
  );

  it.effect(
    "avoids horizontal overflow at 320px and computes distinct light and dark presentation",
    () =>
      Effect.gen(function* () {
        const mobileFixtures = [
          "login",
          "consent",
          "client",
          "mail-thread",
          "pending",
          "accepted",
        ] as const;
        for (const fixture of mobileFixtures) {
          const mobile = yield* observe(fixture, { width: 320, height: 900, colorScheme: "light" });
          expect(mobile.documentScrollWidth, `${fixture} scroll width`).toBeLessThanOrEqual(
            mobile.documentClientWidth,
          );
          expect(mobile.documentClientWidth).toBe(320);
        }

        const light = yield* observe("pending", {
          width: 1280,
          height: 900,
          colorScheme: "light",
        });
        const dark = yield* observe("pending", {
          width: 1280,
          height: 900,
          colorScheme: "dark",
        });
        expect(light.documentScrollWidth).toBeLessThanOrEqual(light.documentClientWidth);
        expect(dark.documentScrollWidth).toBeLessThanOrEqual(dark.documentClientWidth);
        expect(light.darkSchemeMatches).toBe(false);
        expect(dark.darkSchemeMatches).toBe(true);
        expect(dark.bodyBackground).not.toBe(light.bodyBackground);
        expect(dark.bodyColor).not.toBe(light.bodyColor);
      }),
  );
});

type BrowserVisitOptions = {
  readonly width: number;
  readonly height: number;
  readonly colorScheme: "light" | "dark";
  readonly search?: string;
};

const observe = Effect.fn("observe")(function* (
  fixture: WebPageBrowserFixture,
  options: BrowserVisitOptions = { width: 1280, height: 900, colorScheme: "light" },
) {
  const visit =
    options.search === undefined
      ? new WebPageBrowserVisit({
          fixture,
          colorScheme: options.colorScheme,
          viewportWidth: options.width,
          viewportHeight: options.height,
        })
      : new WebPageBrowserVisit({
          fixture,
          colorScheme: options.colorScheme,
          viewportWidth: options.width,
          viewportHeight: options.height,
          search: options.search,
        });
  const raw = yield* Effect.promise(() => commands.observeWebPage(visit));
  return yield* Schema.decodeEffect(WebPageBrowserObservationSchema)(raw);
});

function cspScriptNonce(contentSecurityPolicy: string | null): string | null {
  if (contentSecurityPolicy === null) {
    return null;
  }
  return /script-src 'nonce-([0-9a-f]{32})'/u.exec(contentSecurityPolicy)?.[1] ?? null;
}

function cspViolations(observation: WebPageBrowserObservation) {
  return observation.consoleMessages.filter(isCspViolation);
}

function isCspViolation(message: string): boolean {
  return (
    message.includes("Content Security Policy") ||
    message.includes("violates the following Content Security Policy")
  );
}

function isSandboxPopupDenial(message: string): boolean {
  return message.includes("sandboxed") && message.includes("allow-popups");
}
