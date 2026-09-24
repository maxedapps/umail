import { defineBrowserCommand } from "@vitest/browser-playwright";
import {
  ApprovalToken,
  hashApprovalToken,
  NormalizedRfcMessageId,
  requireApprovalSendMode,
  SubmissionRequestId,
  SubmitMessagePayload,
  type Principal,
  type PrincipalPolicy,
} from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Frame, Locator, Page } from "playwright";
import type { Plugin } from "vitest/config";

import { submitMessage } from "../../src/api/operations.ts";
import { PREVIEW_EXTERNAL_ORIGIN, PREVIEW_HTML_SOURCE } from "./fakes.ts";
import { registerMcpClient } from "./oauth-flow.ts";
import {
  APPLICATION_ORIGIN,
  APPLICATION_URL,
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
  createWorld,
  runDueWorkPass,
  seedMailbox,
  type World,
} from "./world.ts";
import {
  HumanPageBrowserFixture,
  HumanPageBrowserVisit,
  type HumanPageBrowserObservation,
} from "./human-pages-browser-model.ts";

const FIXTURE_PREFIX = "/__human-pages__";
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const NOW = "2026-08-28T10:00:00.000Z";
// The "expired" approval is submitted a day early, so a pass at its deadline leaves the rest open.
const EXPIRED_SUBMITTED_AT = "2026-08-27T09:00:00.000Z";
const EXPIRE_AT = "2026-08-28T09:00:00.000Z";
const UNKNOWN_APPROVAL_PATH = `/approvals/${"f".repeat(64)}`;
const HOSTILE_SUBJECT = "Quarterly\r\nreview \u202e<script data-hostile-subject>subject</script>";
const HOSTILE_FROM = "Sender \u2066<script data-hostile-from>name</script>";
const HOSTILE_RECIPIENT = "Recipient \u202a<svg data-hostile-recipient>name</svg>";
const HOSTILE_REQUESTER = "Reviewer\r\n\u202e<script data-hostile-requester>requester</script>";

type HumanPageFixtureRequest = IncomingMessage;
type HumanPageFixtureResponse = ServerResponse<IncomingMessage>;

type PreparedBrowserWorld = {
  readonly world: World;
  readonly paths: Record<HumanPageBrowserFixture, string>;
};

export const humanPageBrowserCommands = {
  observeHumanPage: defineBrowserCommand(
    async (
      { context, page: runnerPage },
      input: HumanPageBrowserVisit,
    ): Promise<HumanPageBrowserObservation> => {
      const visit = Schema.decodeSync(HumanPageBrowserVisit)(input);
      const existingPages = new Set(context.pages());
      const page = await context.newPage();
      const consoleMessages: Array<string> = [];
      const externalRequests: Array<string> = [];
      page.on("console", (message) => consoleMessages.push(message.text()));
      page.on("request", (request) => {
        if (request.url().startsWith(PREVIEW_EXTERNAL_ORIGIN)) {
          externalRequests.push(request.url());
        }
      });

      try {
        const prepared = await preparedBrowserWorld();
        await context.clearCookies();
        await context.addCookies(sessionCookies(prepared.world, runnerPage.url()));
        await page.setViewportSize({
          width: visit.viewportWidth,
          height: visit.viewportHeight,
        });
        await page.emulateMedia({ colorScheme: visit.colorScheme });
        const fixtureUrl = new URL(fixturePath(visit.fixture, visit.search), runnerPage.url());
        const previewResponsePromise =
          visit.fixture === "pending"
            ? page.waitForResponse((response) => isPreviewPath(new URL(response.url()).pathname))
            : null;
        const navigationResponse = await page.goto(fixtureUrl.href, { waitUntil: "load" });
        if (navigationResponse === null) {
          throw new Error("Human-page browser fixture navigation returned no response.");
        }
        const previewResponse =
          previewResponsePromise === null ? null : await previewResponsePromise;
        const focus = await exerciseFixture(page, visit);
        const buttons = await buttonObservations(page);
        const form = page.locator("form").first();
        const formCount = await page.locator("form").count();
        const formMethod = formCount === 0 ? null : await form.getAttribute("method");
        const formAction = formCount === 0 ? null : await form.getAttribute("action");
        const metadataText = await optionalText(page.locator(".message-details"));
        const messageBodyBox = await optionalBoundingBox(page.locator(".message-preview"));
        const decisionBox = await optionalBoundingBox(page.locator(".decision-panel"));
        const clientId = await optionalText(page.locator("#client-id"));
        const scope = await optionalText(page.locator("#scope"));
        const redirectHost = await optionalText(page.locator("#redirect-host"));
        const scriptNonce = await page.evaluate(pageOwnedScriptNonce);
        const heading = (await page.locator("h1").textContent()) ?? "";
        const title = await page.title();
        const bodyText = await page.locator("body").innerText();
        const hostileElementCount = await page
          .locator(
            "[data-hostile-subject], [data-hostile-from], [data-hostile-recipient], [data-hostile-requester]",
          )
          .count();
        const layout = await page.evaluate(() => {
          const bodyStyle = getComputedStyle(document.body);
          return {
            documentClientWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            bodyBackground: bodyStyle.backgroundColor,
            bodyColor: bodyStyle.color,
            darkSchemeMatches: matchMedia("(prefers-color-scheme: dark)").matches,
          };
        });
        const consentAuth = visit.fixture === "consent" ? await submitConsent(page) : null;

        let iframeSandbox: string | null = null;
        let previewBodyText: string | null = null;
        let previewUrlBeforeActivation: string | null = null;
        let previewUrlAfterActivation: string | null = null;
        let openedPageCount = 0;
        if (visit.fixture === "pending") {
          const iframe = page.locator('iframe[title="HTML email preview"]');
          iframeSandbox = await iframe.getAttribute("sandbox");
          const previewFrame = requiredPreviewFrame(page);
          previewBodyText = await previewFrame.locator("body").innerText();
          previewUrlBeforeActivation = previewFrame.url();
          const pagesBeforeActivation = context.pages().length;
          await previewFrame.locator("#external-preview-link").click();
          previewUrlAfterActivation = requiredPreviewFrame(page).url();
          openedPageCount = context.pages().length - pagesBeforeActivation;
        }

        return {
          status: navigationResponse.status(),
          contentType: navigationResponse.headers()["content-type"] ?? null,
          contentSecurityPolicy: navigationResponse.headers()["content-security-policy"] ?? null,
          frameOptions: navigationResponse.headers()["x-frame-options"] ?? null,
          title,
          heading,
          bodyText,
          formCount,
          formMethod,
          formAction,
          buttons,
          keyboardFocusId: focus.keyboardFocusId,
          keyboardFocusText: focus.keyboardFocusText,
          focusOutlineStyle: focus.outlineStyle,
          focusOutlineWidth: focus.outlineWidth,
          controlHeight: focus.controlHeight,
          scriptNonce,
          clientId,
          scope,
          redirectHost,
          statusText: consentAuth?.statusText ?? focus.statusText,
          authRequestPath: consentAuth?.authRequestPath ?? focus.authRequestPath,
          authRequestMethod: consentAuth?.authRequestMethod ?? focus.authRequestMethod,
          authRequestBody: consentAuth?.authRequestBody ?? focus.authRequestBody,
          finalPath: new URL(page.url()).pathname,
          secretValue: focus.secretValue,
          hostileElementCount,
          metadataText,
          metadataBidiControlCount: metadataText?.match(BIDI_CONTROL)?.length ?? 0,
          automaticIsolationCount: await page.locator('.message-details bdi[dir="auto"]').count(),
          addressIsolationCount: await page.locator('.message-details bdi[dir="ltr"]').count(),
          sectionsSeparated:
            messageBodyBox === null || decisionBox === null
              ? null
              : decisionBox.y >= messageBodyBox.y + messageBodyBox.height,
          ...layout,
          iframeSandbox,
          previewContentSecurityPolicy:
            previewResponse?.headers()["content-security-policy"] ?? null,
          previewFrameOptions: previewResponse?.headers()["x-frame-options"] ?? null,
          previewBodyText,
          previewUrlBeforeActivation,
          previewUrlAfterActivation,
          externalRequests,
          openedPageCount,
          consoleMessages,
        };
      } finally {
        for (const openPage of context.pages()) {
          if (!existingPages.has(openPage)) {
            await openPage.close();
          }
        }
      }
    },
  ),
};

export function humanPageBrowserFixture(): Plugin {
  return {
    name: "human-page-browser-fixture",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = requestUrl(request);
        if (url === null) {
          writeStatus(response, 400);
          return;
        }
        const prepared = await preparedBrowserWorld();
        const fixture = fixtureFromPath(url.pathname);
        if (fixture !== null) {
          const target = resolveFixtureUrl(url, prepared);
          response.statusCode = 302;
          response.setHeader("location", `${target.pathname}${target.search}`);
          response.setHeader("cache-control", "no-store");
          response.end();
          return;
        }
        if (!shouldProxy(url.pathname)) {
          next();
          return;
        }
        const webRequest = await incomingToWebRequest(request, url);
        const worldResponse = await prepared.world.fetch(
          worldUrl(url).href,
          await worldRequestInit(webRequest, prepared.world),
        );
        await writeWorldResponse(response, worldResponse, `http://${request.headers.host ?? ""}`);
      });
    },
  };
}

type BrowserFocusObservation = {
  readonly keyboardFocusId: string | null;
  readonly keyboardFocusText: string | null;
  readonly outlineStyle: string | null;
  readonly outlineWidth: string | null;
  readonly controlHeight: number | null;
  readonly statusText: string | null;
  readonly authRequestPath: string | null;
  readonly authRequestMethod: string | null;
  readonly authRequestBody: string | null;
  readonly secretValue: string | null;
};

async function exerciseFixture(
  page: Page,
  visit: HumanPageBrowserVisit,
): Promise<BrowserFocusObservation> {
  if (visit.fixture === "login") {
    const email = page.getByLabel("Operator email");
    const secret = page.getByLabel("Operator secret");
    await email.focus();
    await page.keyboard.press("Tab");
    const focus = await focusedControl(page);
    await email.fill(OPERATOR_EMAIL);
    await secret.fill(OPERATOR_PASSWORD);
    const requestPromise = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/auth/sign-in/email",
    );
    await page.locator("#login-submit").focus();
    await page.keyboard.press("Enter");
    const authRequest = await requestPromise;
    const authRequestBody = authRequest.postData();
    const authRequestPath = new URL(authRequest.url()).pathname;
    const authRequestMethod = authRequest.method();
    if (visit.search === "next=/clients") {
      await page.waitForURL((url) => new URL(url).pathname === "/clients");
      return {
        ...focus,
        statusText: null,
        authRequestPath,
        authRequestMethod,
        authRequestBody,
        secretValue: null,
      };
    }
    if (visit.search !== undefined && visit.search.includes("sig=")) {
      return {
        ...focus,
        statusText: null,
        authRequestPath,
        authRequestMethod,
        authRequestBody,
        secretValue: null,
      };
    }
    await page.waitForFunction(
      () =>
        document.getElementById("status")?.textContent ===
        "Signed in. Continue to the authorization request or use umail login.",
    );
    return {
      ...focus,
      statusText: await optionalText(page.locator("#status")),
      authRequestPath: new URL(authRequest.url()).pathname,
      authRequestMethod: authRequest.method(),
      authRequestBody: authRequest.postData(),
      secretValue: await secret.inputValue(),
    };
  }
  if (visit.fixture === "consent") {
    const accept = page.getByRole("button", { name: "Allow access" });
    await accept.focus();
    await page.keyboard.press("Tab");
    return {
      ...(await focusedControl(page)),
      statusText: null,
      authRequestPath: null,
      authRequestMethod: null,
      authRequestBody: null,
      secretValue: null,
    };
  }
  if (visit.fixture === "pending") {
    await page.getByRole("button", { name: "Approve & send" }).focus();
    await page.keyboard.press("Tab");
    return {
      ...(await focusedControl(page)),
      statusText: null,
      authRequestPath: null,
      authRequestMethod: null,
      authRequestBody: null,
      secretValue: null,
    };
  }
  return {
    keyboardFocusId: null,
    keyboardFocusText: null,
    outlineStyle: null,
    outlineWidth: null,
    controlHeight: null,
    statusText: null,
    authRequestPath: null,
    authRequestMethod: null,
    authRequestBody: null,
    secretValue: null,
  };
}

async function submitConsent(page: Page) {
  const accept = page.getByRole("button", { name: "Allow access" });
  const requestPromise = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/auth/oauth2/consent",
  );
  await accept.focus();
  await page.keyboard.press("Enter");
  const authRequest = await requestPromise;
  await Promise.race([
    page.waitForFunction(
      () => {
        const text = document.getElementById("status")?.textContent ?? "";
        return text === "Consent recorded." || text === "Could not complete consent.";
      },
      { timeout: 2000 },
    ),
    page.waitForURL(
      (url) => {
        const path = new URL(url).pathname;
        return path !== "/consent" && !path.startsWith("/__human-pages__/");
      },
      { timeout: 2000, waitUntil: "commit" },
    ),
  ]).catch(() => undefined);
  return {
    statusText: await optionalText(page.locator("#status")).catch(() => null),
    authRequestPath: new URL(authRequest.url()).pathname,
    authRequestMethod: authRequest.method(),
    authRequestBody: authRequest.postData(),
  };
}

async function focusedControl(page: Page) {
  const focused = page.locator(":focus");
  const styles = await focused.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { outlineStyle: computed.outlineStyle, outlineWidth: computed.outlineWidth };
  });
  const box = await focused.boundingBox();
  return {
    keyboardFocusId: await focused.getAttribute("id"),
    keyboardFocusText: (await focused.textContent())?.trim() ?? null,
    ...styles,
    controlHeight: box?.height ?? null,
  };
}

async function buttonObservations(page: Page) {
  const observations = [];
  for (const button of await page.locator("button").all()) {
    observations.push({
      name: (await button.textContent())?.trim() ?? "",
      type: (await button.getAttribute("type")) ?? "",
      formAction: (await button.getAttribute("formaction")) ?? "",
    });
  }
  return observations;
}

function requiredPreviewFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => isPreviewPath(new URL(candidate.url()).pathname));
  if (frame === undefined) {
    throw new Error("Expected the approval message preview frame to be loaded.");
  }
  return frame;
}

async function optionalText(locator: Locator): Promise<string | null> {
  return (await locator.count()) === 0 ? null : await locator.first().textContent();
}

async function optionalBoundingBox(locator: Locator) {
  return (await locator.count()) === 0 ? null : await locator.first().boundingBox();
}

function fixturePath(fixture: HumanPageBrowserFixture, search: string | undefined): string {
  const path = `${FIXTURE_PREFIX}/${fixture}`;
  if (search === undefined || search.length === 0) return path;
  const query = search.startsWith("?") ? search.slice(1) : search;
  return `${path}?${query}`;
}

function fixtureFromPath(pathname: string): HumanPageBrowserFixture | null {
  const value = pathname.startsWith(`${FIXTURE_PREFIX}/`)
    ? pathname.slice(FIXTURE_PREFIX.length + 1)
    : "";
  const decoded = Schema.decodeUnknownResult(HumanPageBrowserFixture)(value);
  return decoded._tag === "Failure" ? null : decoded.success;
}

function shouldProxy(pathname: string): boolean {
  return (
    pathname.startsWith(`${FIXTURE_PREFIX}/`) ||
    pathname === "/login" ||
    pathname === "/consent" ||
    pathname === "/clients" ||
    pathname.startsWith("/clients/") ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/approvals/") ||
    pathname === "/device" ||
    pathname.startsWith("/device/") ||
    pathname === "/jwks" ||
    pathname.startsWith("/.well-known/")
  );
}

function isPreviewPath(pathname: string): boolean {
  return /^\/approvals\/[0-9a-f]{64}\/message$/u.test(pathname);
}

function resolveFixtureUrl(url: URL, prepared: PreparedBrowserWorld): URL {
  const fixture = fixtureFromPath(url.pathname);
  if (fixture === null) {
    return url;
  }
  const resolved = new URL(prepared.paths[fixture], url.origin);
  for (const [key, value] of url.searchParams.entries()) {
    if (!resolved.searchParams.has(key)) {
      resolved.searchParams.append(key, value);
    }
  }
  return resolved;
}

function worldUrl(url: URL): URL {
  return new URL(`${url.pathname}${url.search}`, APPLICATION_URL);
}

async function worldRequestInit(request: Request, world: World): Promise<RequestInit> {
  const headers = new Headers(request.headers);
  headers.set("host", APPLICATION_URL.host);
  if (headers.has("origin")) {
    headers.set("origin", APPLICATION_ORIGIN);
  }
  const referer = headers.get("referer");
  if (referer !== null) {
    const parsed = URL.parse(referer);
    if (parsed !== null) {
      headers.set("referer", new URL(`${parsed.pathname}${parsed.search}`, APPLICATION_URL).href);
    }
  }
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/auth/sign-in/email") {
    headers.delete("cookie");
  } else if (pathname === "/api/auth/oauth2/consent") {
    headers.set("cookie", world.sessionCookie);
  } else {
    headers.set("cookie", cookieHeaderForWorld(headers.get("cookie"), world.sessionCookie));
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Buffer.from(await request.arrayBuffer());
  }
  return init;
}

function requestUrl(request: HumanPageFixtureRequest): URL | null {
  const host = request.headers.host;
  return host === undefined ? null : new URL(request.url ?? "/", `http://${host}`);
}

async function writeWorldResponse(
  response: HumanPageFixtureResponse,
  webResponse: Response,
  browserOrigin: string,
): Promise<void> {
  response.statusCode = webResponse.status;
  const location = webResponse.headers.get("location");
  webResponse.headers.forEach((value, name) => {
    if (name === "set-cookie" || name === "location") {
      return;
    }
    response.setHeader(name, value);
  });
  if (location !== null) {
    response.setHeader("location", rewriteLocation(location, browserOrigin));
  }
  const cookies = setCookieValues(webResponse);
  for (const cookie of cookies) {
    response.appendHeader("set-cookie", rewriteSetCookie(cookie));
  }
  response.end(await webResponse.text());
}

function rewriteLocation(location: string, browserOrigin: string): string {
  if (!location.startsWith(APPLICATION_ORIGIN)) {
    return location;
  }
  return `${browserOrigin}${location.slice(APPLICATION_ORIGIN.length)}`;
}

function setCookieValues(webResponse: Response): ReadonlyArray<string> {
  const cookies = webResponse.headers.getSetCookie();
  if (cookies.length > 0) {
    return cookies;
  }
  const combined = webResponse.headers.get("set-cookie");
  return combined === null ? [] : [combined];
}

function cookieHeaderForWorld(browserCookie: string | null, worldSessionCookie: string): string {
  if (browserCookie === null || browserCookie.length === 0) {
    return worldSessionCookie;
  }
  const worldName = worldSessionCookie.split("=")[0] ?? "";
  const browserName = publicCookieName(worldName);
  if (worldName.length === 0 || worldName === browserName) {
    return browserCookie;
  }
  const parts = [];
  for (const part of browserCookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${browserName}=`)) {
      parts.push(`${worldName}=${trimmed.slice(browserName.length + 1)}`);
    } else {
      parts.push(trimmed);
    }
  }
  return parts.join("; ");
}

function publicCookieName(name: string): string {
  if (name.startsWith("__Secure-")) {
    return name.slice("__Secure-".length);
  }
  if (name.startsWith("__Host-")) {
    return name.slice("__Host-".length);
  }
  return name;
}

function rewriteSetCookie(cookie: string): string {
  const parts = [];
  for (const [index, raw] of cookie.split(";").entries()) {
    const trimmed = raw.trim();
    if (index === 0) {
      const separator = trimmed.indexOf("=");
      if (separator > 0) {
        const name = publicCookieName(trimmed.slice(0, separator));
        parts.push(`${name}=${trimmed.slice(separator + 1)}`);
        continue;
      }
    }
    const attr = trimmed.split("=", 1)[0]?.toLowerCase();
    if (attr === "domain" || attr === "secure") {
      continue;
    }
    parts.push(trimmed);
  }
  return parts.join("; ");
}

function writeStatus(response: HumanPageFixtureResponse, status: number): void {
  response.statusCode = status;
  response.end();
}

let sharedWorld: Promise<PreparedBrowserWorld> | null = null;

function preparedBrowserWorld(): Promise<PreparedBrowserWorld> {
  if (sharedWorld === null) {
    sharedWorld = createPreparedBrowserWorld();
  }
  return sharedWorld;
}

async function createPreparedBrowserWorld(): Promise<PreparedBrowserWorld> {
  const world = await createWorld();
  const mailbox = await seedMailbox(world, "inbox", HOSTILE_FROM);
  const principal = approvalPrincipal();
  const pending = await submitApproval(world, principal, mailbox.id, {
    subject: HOSTILE_SUBJECT,
    html: PREVIEW_HTML_SOURCE,
  });
  const accepted = await submitApproval(world, principal, mailbox.id, { subject: "Accepted" });
  const failed = await submitApproval(world, principal, mailbox.id, { subject: "Failed" });
  const queued = await submitApproval(world, principal, mailbox.id, { subject: "Queued" });
  const denied = await submitApproval(world, principal, mailbox.id, { subject: "Denied" });
  world.approvalClock.set(EXPIRED_SUBMITTED_AT);
  const expired = await submitApproval(world, principal, mailbox.id, { subject: "Expired" });
  world.approvalClock.set(NOW);
  await approveAndAccept(world, accepted);
  await approveAndFail(world, failed);
  await decide(world, denied.token, "denied");
  await expire(world, expired.token);
  // Approved last, so no pass sends it: its page shows the approved message as sending.
  await decide(world, queued.token, "approved");
  const consentPath = await consentAuthorizePath(world);
  return {
    world,
    paths: {
      login: "/login",
      consent: consentPath,
      pending: approvalPath(pending.token),
      accepted: approvalPath(accepted.token),
      failed: approvalPath(failed.token),
      queued: approvalPath(queued.token),
      denied: approvalPath(denied.token),
      expired: approvalPath(expired.token),
      unknown: UNKNOWN_APPROVAL_PATH,
    },
  };
}

type BrowserComposeDraft = {
  intent: "compose";
  requestId: SubmissionRequestId;
  fromAddressId: string;
  to: [{ address: "recipient.with.a.very.long.local.part@example.com"; displayName: string }];
  cc: ReadonlyArray<{ address: "copy@example.com" | "other-copy@example.com"; displayName: null }>;
  subject: string;
  text: string;
  html?: string;
};

// The requesting client has no OAuth consent, so the due-work pass is handed its policy directly.
const APPROVAL_POLICY = {
  mailboxIds: "all",
  canRead: true,
  sendMode: requireApprovalSendMode(),
  recipientAllowlist: "any",
} as const satisfies PrincipalPolicy;

function approvalPrincipal(): Principal {
  return {
    authority: "mcp",
    identity: {
      kind: "oauth",
      userId: "operator-1",
      clientId: "browser-oauth-client",
      clientLabel: HOSTILE_REQUESTER,
    },
    policy: APPROVAL_POLICY,
  };
}

async function submitApproval(
  world: World,
  principal: Principal,
  mailboxId: string,
  input: { readonly subject: string; readonly html?: string },
) {
  const draft: BrowserComposeDraft = {
    intent: "compose",
    requestId: Schema.decodeSync(SubmissionRequestId)(crypto.randomUUID()),
    fromAddressId: mailboxId,
    to: [
      {
        address: "recipient.with.a.very.long.local.part@example.com",
        displayName: HOSTILE_RECIPIENT,
      },
    ],
    cc: [
      { address: "copy@example.com", displayName: null },
      { address: "other-copy@example.com", displayName: null },
    ],
    subject: input.subject,
    text: "Hello reviewer,\n\nThis text stays visibly separate from the decision controls.",
  };
  if (input.html !== undefined) {
    draft.html = input.html;
  }
  const job = await Effect.runPromise(
    submitMessage(world.deps, principal, Schema.decodeSync(SubmitMessagePayload)(draft)),
  );
  if (job.state !== "waiting_approval") {
    throw new Error("expected a parked approval job");
  }
  return { job, token: await notifiedApprovalToken(world) };
}

// Sends the message's approval notification through the store's due-work pass and reads the review
// token from the email, as the operator would.
async function notifiedApprovalToken(world: World): Promise<string> {
  const mails = await runDueWorkPass(world, { mcpPolicy: APPROVAL_POLICY });
  const token = /\/approvals\/([0-9a-f]{64})/u.exec(mails.at(-1)?.text ?? "")?.[1];
  if (token === undefined) {
    throw new Error("expected an approval notification email");
  }
  return token;
}

async function decide(world: World, token: string, decision: "approved" | "denied") {
  const tokenHash = await hashApprovalToken(Schema.decodeSync(ApprovalToken)(token));
  const claimed = await Effect.runPromise(
    world.account.decideApproval({ tokenHash, decision, nowIso: NOW }),
  );
  if (claimed.kind !== "claimed") {
    throw new Error("expected the approval decision to be claimed");
  }
}

async function approveAndAccept(world: World, submitted: { readonly token: string }) {
  await decide(world, submitted.token, "approved");
  await runDueWorkPass(world, {
    mcpPolicy: APPROVAL_POLICY,
    outcome: {
      kind: "accepted",
      providerMessageId: "provider-browser",
      rfcMessageId: Schema.decodeSync(NormalizedRfcMessageId)("<provider-browser@example.test>"),
    },
  });
}

async function approveAndFail(world: World, submitted: { readonly token: string }) {
  await decide(world, submitted.token, "approved");
  await runDueWorkPass(world, {
    mcpPolicy: APPROVAL_POLICY,
    outcome: { kind: "rejected", failureDetail: "E_RECIPIENT_SUPPRESSED" },
  });
}

async function expire(world: World, token: string) {
  const tokenHash = await hashApprovalToken(Schema.decodeSync(ApprovalToken)(token));
  await runDueWorkPass(world, { at: EXPIRE_AT, mcpPolicy: APPROVAL_POLICY });
  const expired = await Effect.runPromise(world.account.lookupApprovalByTokenHash(tokenHash));
  if (expired.kind !== "found" || expired.approval.state !== "expired") {
    throw new Error("expected the approval to expire");
  }
}

async function consentAuthorizePath(world: World): Promise<string> {
  const registered = await registerMcpClient(world, { label: "Browser consent" });
  const verifier = "umail-browser-verifier-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFG";
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const authorize = await world.fetch(
    `http://umail.test/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: registered.clientId,
      redirect_uri: registered.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "umail-browser-consent",
      resource: "https://umail.test/mcp",
      scope: "umail:access offline_access",
    }).toString()}`,
    { redirect: "manual", headers: { cookie: world.sessionCookie } },
  );
  const location = authorize.headers.get("location");
  if (location === null) {
    throw new Error("OAuth authorization did not return a consent location");
  }
  const consent = new URL(location, APPLICATION_URL);
  return `${consent.pathname}${consent.search}`;
}

function approvalPath(token: string): string {
  return `/approvals/${token}`;
}

function sessionCookies(world: World, pageUrl: string) {
  const parsed = parseSessionCookie(world.sessionCookie, pageUrl);
  if (parsed === null) {
    throw new Error(`invalid session cookie for browser origin ${pageUrl}`);
  }
  return [parsed];
}

function parseSessionCookie(sessionCookie: string, pageUrl: string) {
  const parsedUrl = URL.parse(pageUrl);
  if (parsedUrl === null || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
    return null;
  }
  const pair = sessionCookie.split(";", 1)[0]?.trim() ?? "";
  const separator = pair.indexOf("=");
  if (separator <= 0) {
    return null;
  }
  let name = pair.slice(0, separator).trim();
  let value = pair.slice(separator + 1).trim();
  const comma = value.indexOf(",");
  if (comma >= 0) {
    value = value.slice(0, comma).trim();
  }
  name = publicCookieName(name);
  if (name.length === 0 || value.length === 0) {
    return null;
  }
  return {
    name,
    value,
    url: `${parsedUrl.protocol}//${parsedUrl.host}/`,
  };
}

async function incomingToWebRequest(request: HumanPageFixtureRequest, url: URL): Promise<Request> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  const init: RequestInit = {
    method: request.method ?? "GET",
    headers,
  };
  if (body.byteLength > 0) {
    init.body = body;
  }
  return new Request(url.href, init);
}

function pageOwnedScriptNonce(): string | null {
  const script = document.querySelector("script[nonce]");
  return script instanceof HTMLScriptElement ? script.nonce : null;
}
