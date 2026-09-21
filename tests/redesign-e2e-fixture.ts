import { defineBrowserCommand } from "@vitest/browser-playwright";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Page } from "playwright";
import type { Plugin } from "vitest/config";

import {
  APPLICATION_ORIGIN,
  APPLICATION_URL,
  OPERATOR_EMAIL,
  OPERATOR_PASSWORD,
} from "../apps/server/test/api/world.ts";
import {
  countInboundMessages,
  createLocalTarget,
  deliverInbound,
  dispatchReadySends,
  localAgentLabel,
  policyLabel,
  postPolicyFromOrigin,
  readAttachment,
  readJob,
  redriveIndexedReceipts,
  signupStatus,
  submitApprovedReply,
  type LocalTarget,
} from "./redesign-e2e-local.ts";
import {
  LocalTargetFlowObservation,
  LocalTargetRegressionObservation,
} from "./redesign-e2e-model.ts";

type FixtureRequest = IncomingMessage;
type FixtureResponse = ServerResponse<IncomingMessage>;

export const localTargetCommands = {
  runLocalTargetFlow: defineBrowserCommand(
    async ({ context, page: runnerPage }): Promise<typeof LocalTargetFlowObservation.Type> => {
      const existingPages = new Set(context.pages());
      const page = await context.newPage();
      try {
        const target = await localTarget();
        await context.clearCookies();
        await page.goto(new URL("/login?next=/clients", runnerPage.url()).href, {
          waitUntil: "load",
        });
        const email = page.getByLabel("Operator email");
        const secret = page.getByLabel("Operator secret");
        await email.waitFor();
        await email.fill(OPERATOR_EMAIL);
        await secret.fill(OPERATOR_PASSWORD);
        await page.locator("#login-submit").focus();
        await page.keyboard.press("Enter");
        await page.waitForURL((url) => new URL(url).pathname === "/clients");
        const loginFinalPath = new URL(page.url()).pathname;

        await page.getByLabel("Client label").fill(localAgentLabel());
        await page.getByLabel("Send mode").selectOption("requireApproval");
        await page.getByRole("button", { name: "Save policy" }).click();
        await page.waitForURL((url) => new URL(url).pathname === "/clients");
        const savedLabel = await policyLabel(target);
        const policySendMode = await page.getByLabel("Send mode").inputValue();

        const inbound = await deliverInbound(target);
        const inboundAttachment = await readAttachment(
          target,
          inbound.messageId,
          inbound.attachmentId,
        );
        const submitted = await submitApprovedReply(target, inbound.messageId);
        if (submitted.job.state !== "waiting_approval") {
          throw new Error(`expected waiting_approval, got ${submitted.job.state}`);
        }
        const review = await target.world.fetch(`http://umail.test/approvals/${submitted.token}`);
        const reviewHtml = await review.text();
        if (!reviewHtml.includes("Approve")) {
          throw new Error(
            `approval review ${String(review.status)} did not include a decision: ${reviewHtml.slice(0, 500)}`,
          );
        }

        await context.clearCookies();
        await page.goto(new URL(`/approvals/${submitted.token}`, runnerPage.url()).href, {
          waitUntil: "load",
        });
        const approve = page.getByRole("button", { name: "Approve & send" });
        if ((await approve.count()) === 0) {
          throw new Error(
            `browser approval page missing controls at ${page.url()}: ${await page.locator("body").innerText()}`,
          );
        }
        await approve.click();
        await page.waitForURL((url) => new URL(url).pathname === `/approvals/${submitted.token}`);
        const approvalAfterDecision = await page.locator("body").innerText();

        const providerCalls = await dispatchReadySends(target, true);
        await page.reload({ waitUntil: "load" });
        const approvalAfterSend = await page.locator("body").innerText();
        const job = await readJob(target, submitted.job.jobId);
        const attachment = await readAttachment(target, inbound.messageId, inbound.attachmentId);

        return new LocalTargetFlowObservation({
          loginFinalPath,
          policyLabel: savedLabel,
          policySendMode,
          inboundMessageId: inbound.messageId,
          inboundAttachmentId: inbound.attachmentId,
          inboundAttachmentContentType: inboundAttachment.contentType,
          inboundAttachmentByteLength: inboundAttachment.byteLength,
          replyJobId: submitted.job.jobId,
          replyStateAfterSubmit: submitted.job.state,
          approvalAfterDecision,
          approvalAfterSend,
          providerCalls,
          jobState: job.state,
          jobProviderMessageId: job.providerMessageId,
          attachmentContentType: attachment.contentType,
          attachmentMatchesPng: attachment.matchesPng,
        });
      } finally {
        for (const openPage of context.pages()) {
          if (!existingPages.has(openPage)) {
            await openPage.close();
          }
        }
      }
    },
  ),
  probeLocalTargetRegressions: defineBrowserCommand(
    async ({
      context,
      page: runnerPage,
    }): Promise<typeof LocalTargetRegressionObservation.Type> => {
      const existingPages = new Set(context.pages());
      const page = await context.newPage();
      try {
        const target = await localTarget();
        await context.clearCookies();
        const signup = await signupStatus(target);
        const wrongPasswordStatus = await signInWithWrongPassword(page, runnerPage.url());
        const labelBeforeHostile = await policyLabel(target);
        const hostilePolicyStatus = await postPolicyFromOrigin(
          target,
          "https://evil.example",
          "Hacked",
        );
        const labelAfterHostile = await policyLabel(target);
        if (labelAfterHostile !== labelBeforeHostile) {
          throw new Error("hostile origin mutated the MCP policy");
        }
        await redriveIndexedReceipts(target);
        const inboundCount = await countInboundMessages(target);
        const replay = await page.context().newPage();
        const latestToken = target.world.approvalTokens.at(-1);
        if (latestToken === undefined) {
          throw new Error("expected a capability from the local flow");
        }
        await replay.goto(new URL(`/approvals/${latestToken}`, runnerPage.url()).href, {
          waitUntil: "load",
        });
        const approve = replay.getByRole("button", { name: "Approve & send" });
        if ((await approve.count()) > 0) {
          await approve.click();
        }
        await dispatchReadySends(target, true);
        return new LocalTargetRegressionObservation({
          signupStatus: signup,
          wrongPasswordStatus,
          hostilePolicyStatus,
          policyLabelAfterHostilePost: labelAfterHostile,
          inboundMessageCountAfterDuplicateIndex: inboundCount,
          providerCallsAfterApprovalReplay: target.sender.calls,
        });
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

export function localTargetBrowserFixture(): Plugin {
  return {
    name: "local-target-browser-fixture",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = requestUrl(request);
        if (url === null) {
          writeStatus(response, 400);
          return;
        }
        if (!shouldProxy(url.pathname)) {
          next();
          return;
        }
        const target = await localTarget();
        const webRequest = await incomingToWebRequest(request, url);
        const worldResponse = await target.world.fetch(
          worldUrl(url).href,
          await worldRequestInit(webRequest, target.world.sessionCookie),
        );
        await writeWorldResponse(response, worldResponse, `http://${request.headers.host ?? ""}`);
      });
      const httpServer = server.httpServer;
      if (httpServer !== null) {
        httpServer.once("close", disposeLocalTarget);
      }
    },
  };
}

async function signInWithWrongPassword(page: Page, runnerUrl: string): Promise<string> {
  await page.goto(new URL("/login", runnerUrl).href, { waitUntil: "load" });
  await page.getByLabel("Operator email").fill(OPERATOR_EMAIL);
  await page.getByLabel("Operator secret").fill("not-the-operator-secret");
  await page.locator("#login-submit").click();
  const status = page.locator("#status").filter({
    hasText: "Could not sign in. Check the operator email and secret.",
  });
  await status.waitFor();
  return (await status.textContent()) ?? "";
}

function shouldProxy(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/consent" ||
    pathname === "/clients" ||
    pathname.startsWith("/clients/") ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/approvals/") ||
    pathname === "/device" ||
    pathname.startsWith("/device/") ||
    pathname === "/jwks" ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/messages") ||
    pathname.startsWith("/submissions") ||
    pathname.startsWith("/jobs") ||
    pathname.startsWith("/threads") ||
    pathname.startsWith("/sending-identities") ||
    pathname.startsWith("/addresses") ||
    pathname.startsWith("/forwarding-destinations")
  );
}

function worldUrl(url: URL): URL {
  return new URL(`${url.pathname}${url.search}`, APPLICATION_URL);
}

async function worldRequestInit(
  request: Request,
  worldSessionCookie: string,
): Promise<RequestInit> {
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
  } else {
    const cookie = rewriteBrowserCookie(headers.get("cookie"), worldSessionCookie);
    if (cookie === null) {
      headers.delete("cookie");
    } else {
      headers.set("cookie", cookie);
    }
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

function rewriteBrowserCookie(
  browserCookie: string | null,
  worldSessionCookie: string,
): string | null {
  if (browserCookie === null || browserCookie.length === 0) {
    return null;
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

function requestUrl(request: FixtureRequest): URL | null {
  const host = request.headers.host;
  return host === undefined ? null : new URL(request.url ?? "/", `http://${host}`);
}

async function writeWorldResponse(
  response: FixtureResponse,
  webResponse: Response,
  browserOrigin: string,
): Promise<void> {
  response.statusCode = webResponse.status;
  const location = webResponse.headers.get("location");
  webResponse.headers.forEach((value, name) => {
    if (
      name === "set-cookie" ||
      name === "location" ||
      name === "content-length" ||
      name === "content-encoding" ||
      name === "transfer-encoding"
    ) {
      return;
    }
    response.setHeader(name, value);
  });
  if (location !== null) {
    response.setHeader("location", rewriteLocation(location, browserOrigin));
  }
  for (const cookie of setCookieValues(webResponse)) {
    response.appendHeader("set-cookie", rewriteSetCookie(cookie));
  }
  response.end(Buffer.from(await webResponse.arrayBuffer()));
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

function publicCookieName(name: string): string {
  if (name.startsWith("__Secure-")) {
    return name.slice("__Secure-".length);
  }
  if (name.startsWith("__Host-")) {
    return name.slice("__Host-".length);
  }
  return name;
}

function writeStatus(response: FixtureResponse, status: number): void {
  response.statusCode = status;
  response.end();
}

async function incomingToWebRequest(request: FixtureRequest, url: URL): Promise<Request> {
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

const LOCAL_TARGET_KEY = "__umailLocalE2eTarget" as const;

type LocalTargetHolder = {
  __umailLocalE2eTarget?: Promise<LocalTarget>;
};

function localTargetHolder(): LocalTargetHolder {
  return globalThis as LocalTargetHolder;
}

function localTarget(): Promise<LocalTarget> {
  const holder = localTargetHolder();
  const existing = holder[LOCAL_TARGET_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const created = createLocalTarget();
  holder[LOCAL_TARGET_KEY] = created;
  return created;
}

function disposeLocalTarget(): void {
  const holder = localTargetHolder();
  const pending = holder[LOCAL_TARGET_KEY];
  delete holder[LOCAL_TARGET_KEY];
  if (pending === undefined) {
    return;
  }
  void pending.then(
    (target) => {
      target.dispose();
    },
    () => undefined,
  );
}
