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
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import type { BrowserContext, Frame, Locator, Page } from "playwright";
import type { Plugin } from "vitest/config";
import type { Vite } from "vitest/node";

import { randomId, webCrypto } from "../../src/crypto.ts";
import { submitMessage } from "../../src/api/operations.ts";
import { PREVIEW_EXTERNAL_ORIGIN, PREVIEW_HTML_SOURCE } from "../api/fakes.ts";
import { registerMcpClient } from "../api/oauth-flow.ts";
import {
  APPLICATION_ORIGIN,
  APPLICATION_URL,
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
  createWorld,
  readText,
  runDueWorkPass,
  seedMailbox,
  type World,
} from "../api/world.ts";
import {
  WebPageBrowserFixture,
  WebPageBrowserVisit,
  type WebPageBrowserObservation,
} from "./web-pages-browser-model.ts";

const FIXTURE_PREFIX = "/__web-pages__";
const BIDI_CONTROL = /[؜‎‏‪-‮⁦-⁩]/gu;
const NOW = "2026-08-28T10:00:00.000Z";
// The "expired" approval is submitted a day early, so a pass at its deadline leaves the rest open.
const EXPIRED_SUBMITTED_AT = "2026-08-27T09:00:00.000Z";
const EXPIRE_AT = "2026-08-28T09:00:00.000Z";
const UNKNOWN_APPROVAL_PATH = `/approvals/${"f".repeat(64)}`;
const HOSTILE_SUBJECT = "Quarterly\r\nreview ‮<script data-hostile-subject>subject</script>";
const HOSTILE_FROM = "Sender ⁦<script data-hostile-from>name</script>";
const HOSTILE_RECIPIENT = "Recipient ‪<svg data-hostile-recipient>name</svg>";
const HOSTILE_REQUESTER = "Reviewer\r\n‮<script data-hostile-requester>requester</script>";

type WebPageFixtureRequest = Parameters<Vite.Connect.NextHandleFunction>[0];
type WebPageFixtureResponse = Parameters<Vite.Connect.NextHandleFunction>[1];
type WebPageFixtureNext = Parameters<Vite.Connect.NextHandleFunction>[2];

type PreparedBrowserWorld = {
  readonly world: World;
  readonly paths: Record<WebPageBrowserFixture, string>;
};

export const webPageBrowserCommands = {
  observeWebPage: defineBrowserCommand(
    (
      { context, page: runnerPage },
      input: WebPageBrowserVisit,
    ): Promise<WebPageBrowserObservation> =>
      Effect.runPromise(
        observeWebPage(context, runnerPage, Schema.decodeSync(WebPageBrowserVisit)(input)),
      ),
  ),
};

const observeWebPage = Effect.fn("observeWebPage")(function* (
  context: BrowserContext,
  runnerPage: Page,
  visit: WebPageBrowserVisit,
) {
  const existingPages = new Set(context.pages());
  const page = yield* Effect.acquireRelease(
    Effect.promise(() => context.newPage()),
    () => closeNewPages(context, existingPages),
  );
  const consoleMessages: Array<string> = [];
  const externalRequests: Array<string> = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("request", (request) => {
    if (request.url().startsWith(PREVIEW_EXTERNAL_ORIGIN)) {
      externalRequests.push(request.url());
    }
  });

  const prepared = yield* preparedBrowserWorld;
  yield* Effect.promise(() => context.clearCookies());
  yield* Effect.promise(() => context.addCookies(sessionCookies(prepared.world, runnerPage.url())));
  yield* Effect.promise(() =>
    page.setViewportSize({ width: visit.viewportWidth, height: visit.viewportHeight }),
  );
  yield* Effect.promise(() => page.emulateMedia({ colorScheme: visit.colorScheme }));
  const fixtureUrl = new URL(fixturePath(visit.fixture, visit.search), runnerPage.url());
  // Started before navigation so the preview response cannot be missed.
  const previewResponsePromise =
    visit.fixture === "pending"
      ? page.waitForResponse((response) => isPreviewPath(new URL(response.url()).pathname))
      : null;
  const navigationResponse = yield* Effect.promise(() =>
    page.goto(fixtureUrl.href, { waitUntil: "load" }),
  );
  if (navigationResponse === null) {
    return yield* Effect.die("Web-page browser fixture navigation returned no response.");
  }
  const previewResponse =
    previewResponsePromise === null ? null : yield* Effect.promise(() => previewResponsePromise);
  // Read before the fixture is exercised: signing in navigates away from the page.
  const scriptNonce = yield* Effect.promise(() => page.evaluate(pageOwnedScriptNonce));
  const focus = yield* exerciseFixture(page, visit);
  const buttons = yield* buttonObservations(page);
  const form = page.locator("form").first();
  const formCount = yield* Effect.promise(() => page.locator("form").count());
  const formMethod =
    formCount === 0 ? null : yield* Effect.promise(() => form.getAttribute("method"));
  const formAction =
    formCount === 0 ? null : yield* Effect.promise(() => form.getAttribute("action"));
  const metadataText = yield* optionalText(page.locator(".meta"));
  const messageBodyBox = yield* optionalBoundingBox(page.locator("#message-body"));
  const decisionBox = yield* optionalBoundingBox(page.locator("#decision"));
  const clientId = yield* optionalText(page.locator("#client-id"));
  const scope = yield* optionalText(page.locator("#scope"));
  const redirectHost = yield* optionalText(page.locator("#redirect-host"));
  const heading = (yield* optionalText(page.locator("h1"))) ?? "";
  const title = yield* Effect.promise(() => page.title());
  const bodyText = yield* Effect.promise(() => page.locator("body").innerText());
  const hostileElementCount = yield* Effect.promise(() =>
    page
      .locator(
        "[data-hostile-subject], [data-hostile-from], [data-hostile-recipient], [data-hostile-requester]",
      )
      .count(),
  );
  const layout = yield* Effect.promise(() =>
    page.evaluate(() => {
      const bodyStyle = getComputedStyle(document.body);
      return {
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyBackground: bodyStyle.backgroundColor,
        bodyColor: bodyStyle.color,
        darkSchemeMatches: matchMedia("(prefers-color-scheme: dark)").matches,
      };
    }),
  );
  const consentAuth = visit.fixture === "consent" ? yield* submitConsent(page) : null;

  let iframeSandbox: string | null = null;
  let previewBodyText: string | null = null;
  let previewUrlBeforeActivation: string | null = null;
  let previewUrlAfterActivation: string | null = null;
  let openedPageCount = 0;
  if (visit.fixture === "pending") {
    const iframe = page.locator('iframe[title="HTML email preview"]');
    iframeSandbox = yield* Effect.promise(() => iframe.getAttribute("sandbox"));
    const previewFrame = requiredPreviewFrame(page);
    previewBodyText = yield* Effect.promise(() => previewFrame.locator("body").innerText());
    previewUrlBeforeActivation = previewFrame.url();
    const pagesBeforeActivation = context.pages().length;
    yield* Effect.promise(() => previewFrame.locator("#external-preview-link").click());
    previewUrlAfterActivation = requiredPreviewFrame(page).url();
    openedPageCount = context.pages().length - pagesBeforeActivation;
  }

  const automaticIsolationCount = yield* Effect.promise(() =>
    page.locator('.meta bdi[dir="auto"]').count(),
  );
  const addressIsolationCount = yield* Effect.promise(() =>
    page.locator('.meta bdi[dir="ltr"]').count(),
  );
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
    hostileElementCount,
    metadataText,
    metadataBidiControlCount: metadataText?.match(BIDI_CONTROL)?.length ?? 0,
    automaticIsolationCount,
    addressIsolationCount,
    sectionsSeparated:
      messageBodyBox === null || decisionBox === null
        ? null
        : decisionBox.y >= messageBodyBox.y + messageBodyBox.height,
    ...layout,
    iframeSandbox,
    previewContentSecurityPolicy: previewResponse?.headers()["content-security-policy"] ?? null,
    previewFrameOptions: previewResponse?.headers()["x-frame-options"] ?? null,
    previewBodyText,
    previewUrlBeforeActivation,
    previewUrlAfterActivation,
    externalRequests,
    openedPageCount,
    consoleMessages,
  };
}, Effect.scoped);

const closeNewPages = Effect.fn("closeNewPages")(function* (
  context: BrowserContext,
  existingPages: ReadonlySet<Page>,
) {
  for (const openPage of context.pages()) {
    if (!existingPages.has(openPage)) {
      yield* Effect.promise(() => openPage.close());
    }
  }
});

export function webPageBrowserFixture(): Plugin {
  return {
    name: "web-page-browser-fixture",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void Effect.runPromise(serveFixtureRequest(request, response, next));
      });
    },
  };
}

const serveFixtureRequest = Effect.fn("serveFixtureRequest")(function* (
  request: WebPageFixtureRequest,
  response: WebPageFixtureResponse,
  next: WebPageFixtureNext,
) {
  const url = requestUrl(request);
  if (url === null) {
    writeStatus(response, 400);
    return;
  }
  const prepared = yield* preparedBrowserWorld;
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
  const worldResponse = yield* prepared.world.request(
    worldUrl(url).href,
    yield* worldRequestInit(request, url, prepared.world),
  );
  yield* writeWorldResponse(response, worldResponse, `http://${request.headers.host ?? ""}`);
});

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
};

const exerciseFixture = Effect.fn("exerciseFixture")(function* (
  page: Page,
  visit: WebPageBrowserVisit,
): Effect.fn.Return<BrowserFocusObservation> {
  if (visit.fixture === "login") {
    const email = page.getByLabel("Email");
    const secret = page.getByLabel("Password");
    yield* Effect.promise(() => email.focus());
    yield* Effect.promise(() => page.keyboard.press("Tab"));
    const focus = yield* focusedControl(page);
    yield* Effect.promise(() => email.fill(OPERATOR_EMAIL));
    yield* Effect.promise(() => secret.fill(OPERATOR_PASSWORD));
    const requestPromise = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/auth/sign-in/email",
    );
    yield* Effect.promise(() => page.locator("#login-submit").focus());
    yield* Effect.promise(() => page.keyboard.press("Enter"));
    const authRequest = yield* Effect.promise(() => requestPromise);
    const authRequestBody = authRequest.postData();
    const authRequestPath = new URL(authRequest.url()).pathname;
    const authRequestMethod = authRequest.method();
    // An OAuth continuation is handed to Better Auth's redirect; every other sign-in navigates.
    if (visit.search === undefined || !visit.search.includes("sig=")) {
      yield* Effect.promise(() => page.waitForURL((url) => new URL(url).pathname !== "/login"));
    }
    return { ...focus, statusText: null, authRequestPath, authRequestMethod, authRequestBody };
  }
  if (visit.fixture === "consent") {
    const accept = page.getByRole("button", { name: "Allow access" });
    yield* Effect.promise(() => accept.focus());
    yield* Effect.promise(() => page.keyboard.press("Tab"));
    return {
      ...(yield* focusedControl(page)),
      statusText: null,
      authRequestPath: null,
      authRequestMethod: null,
      authRequestBody: null,
    };
  }
  if (visit.fixture === "pending") {
    yield* Effect.promise(() => page.getByRole("button", { name: "Approve & send" }).focus());
    yield* Effect.promise(() => page.keyboard.press("Tab"));
    return {
      ...(yield* focusedControl(page)),
      statusText: null,
      authRequestPath: null,
      authRequestMethod: null,
      authRequestBody: null,
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
  };
});

const submitConsent = Effect.fn("submitConsent")(function* (page: Page) {
  const accept = page.getByRole("button", { name: "Allow access" });
  const requestPromise = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/auth/oauth2/consent",
  );
  yield* Effect.promise(() => accept.focus());
  yield* Effect.promise(() => page.keyboard.press("Enter"));
  const authRequest = yield* Effect.promise(() => requestPromise);
  // Either outcome settles the page; a timeout leaves the status as it is.
  yield* Effect.tryPromise(() =>
    Promise.race([
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
          return path !== "/consent" && !path.startsWith("/__web-pages__/");
        },
        { timeout: 2000, waitUntil: "commit" },
      ),
    ]),
  ).pipe(Effect.ignore);
  return {
    statusText: yield* optionalText(page.locator("#status")).pipe(
      Effect.catchDefect(() => Effect.succeed(null)),
    ),
    authRequestPath: new URL(authRequest.url()).pathname,
    authRequestMethod: authRequest.method(),
    authRequestBody: authRequest.postData(),
  };
});

const focusedControl = Effect.fn("focusedControl")(function* (page: Page) {
  const focused = page.locator(":focus");
  const styles = yield* Effect.promise(() =>
    focused.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { outlineStyle: computed.outlineStyle, outlineWidth: computed.outlineWidth };
    }),
  );
  const box = yield* Effect.promise(() => focused.boundingBox());
  return {
    keyboardFocusId: yield* Effect.promise(() => focused.getAttribute("id")),
    keyboardFocusText: (yield* Effect.promise(() => focused.textContent()))?.trim() ?? null,
    ...styles,
    controlHeight: box?.height ?? null,
  };
});

const buttonObservations = Effect.fn("buttonObservations")(function* (page: Page) {
  const observations = [];
  for (const button of yield* Effect.promise(() => page.locator("button").all())) {
    observations.push({
      name: (yield* Effect.promise(() => button.textContent()))?.trim() ?? "",
      type: (yield* Effect.promise(() => button.getAttribute("type"))) ?? "",
      formAction: (yield* Effect.promise(() => button.getAttribute("formaction"))) ?? "",
    });
  }
  return observations;
});

function requiredPreviewFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => isPreviewPath(new URL(candidate.url()).pathname));
  if (frame === undefined) {
    throw new Error("Expected the approval message preview frame to be loaded.");
  }
  return frame;
}

const optionalText = Effect.fn("optionalText")(function* (locator: Locator) {
  return (yield* Effect.promise(() => locator.count())) === 0
    ? null
    : yield* Effect.promise(() => locator.first().textContent());
});

const optionalBoundingBox = Effect.fn("optionalBoundingBox")(function* (locator: Locator) {
  return (yield* Effect.promise(() => locator.count())) === 0
    ? null
    : yield* Effect.promise(() => locator.first().boundingBox());
});

function fixturePath(fixture: WebPageBrowserFixture, search: string | undefined): string {
  const path = `${FIXTURE_PREFIX}/${fixture}`;
  if (search === undefined || search.length === 0) return path;
  const query = search.startsWith("?") ? search.slice(1) : search;
  return `${path}?${query}`;
}

function fixtureFromPath(pathname: string): WebPageBrowserFixture | null {
  const value = pathname.startsWith(`${FIXTURE_PREFIX}/`)
    ? pathname.slice(FIXTURE_PREFIX.length + 1)
    : "";
  const decoded = Schema.decodeUnknownResult(WebPageBrowserFixture)(value);
  return decoded._tag === "Failure" ? null : decoded.success;
}

function shouldProxy(pathname: string): boolean {
  return (
    pathname.startsWith(`${FIXTURE_PREFIX}/`) ||
    pathname === "/login" ||
    pathname === "/logout" ||
    pathname === "/mail" ||
    pathname.startsWith("/mail/") ||
    pathname === "/mailboxes" ||
    pathname.startsWith("/mailboxes/") ||
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

// Rewrites the browser's request for the world: its origin, referer and session cookie.
const worldRequestInit = Effect.fn("worldRequestInit")(function* (
  request: WebPageFixtureRequest,
  url: URL,
  world: World,
) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }
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
  if (url.pathname === "/api/auth/sign-in/email") {
    headers.delete("cookie");
  } else if (url.pathname === "/api/auth/oauth2/consent") {
    headers.set("cookie", world.sessionCookie);
  } else {
    headers.set("cookie", cookieHeaderForWorld(headers.get("cookie"), world.sessionCookie));
  }
  const method = request.method ?? "GET";
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const chunks = yield* Effect.promise(() => Array.fromAsync<Buffer | string>(request));
    init.body = Buffer.concat(
      chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk)),
    );
  }
  return init;
});

function requestUrl(request: WebPageFixtureRequest): URL | null {
  const host = request.headers.host;
  return host === undefined ? null : new URL(request.url ?? "/", `http://${host}`);
}

const writeWorldResponse = Effect.fn("writeWorldResponse")(function* (
  response: WebPageFixtureResponse,
  webResponse: Response,
  browserOrigin: string,
) {
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
  response.end(yield* readText(webResponse));
});

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

function writeStatus(response: WebPageFixtureResponse, status: number): void {
  response.statusCode = status;
  response.end();
}

const createPreparedBrowserWorld = Effect.fn("createPreparedBrowserWorld")(function* () {
  const world = yield* createWorld();
  const mailbox = yield* seedMailbox(world, "inbox", HOSTILE_FROM);
  const principal = approvalPrincipal();
  const pending = yield* submitApproval(world, principal, mailbox.id, {
    subject: HOSTILE_SUBJECT,
    html: PREVIEW_HTML_SOURCE,
  });
  const accepted = yield* submitApproval(world, principal, mailbox.id, { subject: "Accepted" });
  const failed = yield* submitApproval(world, principal, mailbox.id, { subject: "Failed" });
  const queued = yield* submitApproval(world, principal, mailbox.id, { subject: "Queued" });
  const denied = yield* submitApproval(world, principal, mailbox.id, { subject: "Denied" });
  yield* world.setTime(EXPIRED_SUBMITTED_AT);
  const expired = yield* submitApproval(world, principal, mailbox.id, { subject: "Expired" });
  yield* world.setTime(NOW);
  yield* approveAndAccept(world, accepted);
  yield* approveAndFail(world, failed);
  yield* decide(world, denied.token, "denied");
  yield* expire(world, expired.token);
  // Approved last, so no pass sends it: its page shows the approved message as sending.
  yield* decide(world, queued.token, "approved");
  const consentPath = yield* consentAuthorizePath(world);
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
  } satisfies PreparedBrowserWorld;
});

// One world serves both the fixture middleware and the browser command, built on first use.
const preparedBrowserWorld = Effect.runSync(Effect.cached(createPreparedBrowserWorld()));

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
      userId: "operator-1",
      clientId: "browser-oauth-client",
      clientLabel: HOSTILE_REQUESTER,
    },
    policy: APPROVAL_POLICY,
  };
}

const submitApproval = Effect.fn("submitApproval")(function* (
  world: World,
  principal: Principal,
  mailboxId: string,
  input: { readonly subject: string; readonly html?: string },
) {
  const draft: BrowserComposeDraft = {
    intent: "compose",
    requestId: yield* Schema.decodeEffect(SubmissionRequestId)(yield* world.run(randomId)),
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
  const payload = yield* Schema.decodeEffect(SubmitMessagePayload)(draft);
  const job = yield* world.run(submitMessage(world.deps, principal, payload));
  if (job.state !== "waiting_approval") {
    return yield* Effect.die("expected a parked approval job");
  }
  return { job, token: yield* notifiedApprovalToken(world) };
});

// Sends the message's approval notification through the store's due-work pass and reads the review
// token from the email, as the operator would.
const notifiedApprovalToken = Effect.fn("notifiedApprovalToken")(function* (world: World) {
  const mails = yield* runDueWorkPass(world, { mcpPolicy: APPROVAL_POLICY });
  const token = /\/approvals\/([0-9a-f]{64})/u.exec(mails.at(-1)?.text ?? "")?.[1];
  if (token === undefined) {
    return yield* Effect.die("expected an approval notification email");
  }
  return token;
});

const decide = Effect.fn("decide")(function* (
  world: World,
  token: string,
  decision: "approved" | "denied",
) {
  const approvalToken = yield* Schema.decodeEffect(ApprovalToken)(token);
  const tokenHash = yield* world.run(hashApprovalToken(approvalToken));
  const claimed = yield* world.account.decideApproval({ tokenHash, decision, nowIso: NOW });
  if (claimed.kind !== "claimed") {
    return yield* Effect.die("expected the approval decision to be claimed");
  }
});

const approveAndAccept = Effect.fn("approveAndAccept")(function* (
  world: World,
  submitted: { readonly token: string },
) {
  yield* decide(world, submitted.token, "approved");
  yield* runDueWorkPass(world, {
    mcpPolicy: APPROVAL_POLICY,
    outcome: {
      kind: "accepted",
      providerMessageId: "provider-browser",
      rfcMessageId: yield* Schema.decodeEffect(NormalizedRfcMessageId)(
        "<provider-browser@example.test>",
      ),
    },
  });
});

const approveAndFail = Effect.fn("approveAndFail")(function* (
  world: World,
  submitted: { readonly token: string },
) {
  yield* decide(world, submitted.token, "approved");
  yield* runDueWorkPass(world, {
    mcpPolicy: APPROVAL_POLICY,
    outcome: { kind: "rejected", failureDetail: "E_RECIPIENT_SUPPRESSED" },
  });
});

const expire = Effect.fn("expire")(function* (world: World, token: string) {
  const approvalToken = yield* Schema.decodeEffect(ApprovalToken)(token);
  const tokenHash = yield* world.run(hashApprovalToken(approvalToken));
  yield* runDueWorkPass(world, { at: EXPIRE_AT, mcpPolicy: APPROVAL_POLICY });
  const expired = yield* world.account.lookupApprovalByTokenHash(tokenHash);
  if (expired.kind !== "found" || expired.approval.state !== "expired") {
    return yield* Effect.die("expected the approval to expire");
  }
});

const consentAuthorizePath = Effect.fn("consentAuthorizePath")(function* (world: World) {
  const registered = yield* registerMcpClient(world, { label: "Browser consent" });
  const verifier = "umail-browser-verifier-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFG";
  const challenge = Encoding.encodeBase64Url(
    yield* webCrypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(Effect.orDie),
  );
  const authorize = yield* world.request(
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
    return yield* Effect.die("OAuth authorization did not return a consent location");
  }
  const consent = new URL(location, APPLICATION_URL);
  return `${consent.pathname}${consent.search}`;
});

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

function pageOwnedScriptNonce(): string | null {
  const script = document.querySelector("script[nonce]");
  return script instanceof HTMLScriptElement ? script.nonce : null;
}
