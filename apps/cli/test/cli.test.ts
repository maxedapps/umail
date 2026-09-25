import { inspect } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalToken } from "@umail/api-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type { Json } from "effect/Schema";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import { OAuthScheduler, type OAuthSchedulerService } from "../src/auth.ts";
import { OAuthCredentialStore, type OAuthCredentialStoreService } from "../src/credential-store.ts";
import {
  ApprovalTokenInputError,
  ApprovalTokenSource,
  type ApprovalTokenSourceService,
  PublicApprovalRequestError,
} from "../src/approvals.ts";
import { formatCliError, program } from "../src/main.ts";

interface CapturedRequest {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly origin: string | undefined;
  readonly body: string | undefined;
}

type CliResponseFactory = (request: HttpClientRequest.HttpClientRequest, url: URL) => Response;

// The environment the CLI reads its configuration from.
type CliEnv = { readonly UMAIL_URL?: string };

const testEnv = {
  UMAIL_URL: "https://umail.example.test",
} satisfies CliEnv;

const testCredentialStore = {
  read: Effect.succeed({
    origin: "https://umail.example.test",
    scope: "umail:access offline_access",
    accessToken: "test-oauth-access-token",
    refreshToken: "test-oauth-refresh-token",
    expiresAt: Date.now() + 3_600_000,
  }),
  write: () => Effect.void,
  remove: Effect.void,
  withLock: (body) => body,
} satisfies OAuthCredentialStoreService;

const testScheduler = {
  now: Effect.sync(() => Date.now()),
  sleep: () => Effect.void,
} satisfies OAuthSchedulerService;

const approvalTokenText = "a".repeat(64);
const approvalToken = Schema.decodeSync(ApprovalToken)(approvalTokenText);

const approvalTrustedHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'",
  "content-type": "text/html; charset=utf-8",
  "permissions-policy": "camera=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
} as const;

const address = {
  id: "address-1",
  localPart: "inbox",
  address: "inbox@umail.example.test",
  displayName: "Inbox",
  active: true,
  forwardTo: null,
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
};

const sendingIdentity = {
  id: "address-1",
  address: "inbox@umail.example.test",
  displayName: "Inbox",
};

const threadPage = {
  items: [],
  nextCursor: "next-cursor",
};

const threadDetail = {
  threadId: "message-1",
  messages: [],
  nextCursor: "next-thread-message-cursor",
};

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const outboundJob = {
  jobId: "job-1",
  requestId: REQUEST_ID,
  messageId: "message-1",
  threadId: "message-1",
  state: "ready",
  purpose: "message",
  attemptId: null,
  providerMessageId: null,
  rfcMessageId: null,
  failureClass: null,
  failureDetail: null,
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
};

const sentMessage = {
  direction: "outbound",
  id: "message-1",
  threadId: "message-1",
  parentMessageId: null,
  addressId: "address-1",
  subject: "Hello",
  occurredAt: "2026-08-25T10:00:00.000Z",
  from: [{ address: "inbox@umail.example.test", displayName: "Inbox" }],
  replyTo: [{ address: "inbox@umail.example.test", displayName: "Inbox" }],
  to: [{ address: "bob@example.com", displayName: null }],
  cc: [],
  textBody: "Hi",
  htmlBody: null,
  hasRemoteImages: false,
  rfcMessageId: "<provider-1@example.test>",
  inReplyToRfcMessageId: null,
  references: [],
  attachments: [],
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
  sendState: "accepted",
  sendError: null,
  providerMessageId: "provider-1@example.test",
};

const receivedMessage = {
  direction: "inbound",
  id: "received-1",
  threadId: "message-1",
  parentMessageId: null,
  addressId: "address-1",
  subject: "Received",
  occurredAt: "2026-08-25T11:00:00.000Z",
  from: [{ address: "header-sender@example.com", displayName: null }],
  replyTo: [],
  to: [{ address: "visible-recipient@example.com", displayName: null }],
  cc: [],
  textBody: "Received body",
  htmlBody: null,
  hasRemoteImages: false,
  rfcMessageId: "<received-1@example.test>",
  inReplyToRfcMessageId: null,
  references: [],
  attachments: [],
  createdAt: "2026-08-25T11:00:01.000Z",
  updatedAt: "2026-08-25T11:00:01.000Z",
  envelopeFrom: "",
  envelopeTo: "inbox@umail.example.test",
  parsedDate: "2026-08-25T10:00:00.000Z",
  isRead: false,
  readAt: null,
  forwardOutcome: "failure",
  forwardDestination: "forward@example.net",
};

const messagePage = {
  items: [],
  nextCursor: "next-message-cursor",
};

function jsonBody(request: HttpClientRequest.HttpClientRequest) {
  if (request.body._tag === "Uint8Array") {
    return new TextDecoder().decode(request.body.body);
  }
  return undefined;
}

function jsonResponse(value: Json) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function defaultResponse(request: HttpClientRequest.HttpClientRequest, url: URL) {
  if (request.method === "DELETE" && url.pathname.startsWith("/threads/")) {
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/addresses") {
    return request.method === "GET" ? jsonResponse([]) : jsonResponse(address);
  }
  if (url.pathname.endsWith("/forwarding") && request.method === "PUT") {
    return jsonResponse({ address, verified: false });
  }
  if (url.pathname.startsWith("/addresses/")) {
    return jsonResponse(address);
  }
  if (url.pathname === "/sending-identities") {
    return jsonResponse([sendingIdentity]);
  }
  if (url.pathname === "/threads") {
    return jsonResponse(threadPage);
  }
  if (url.pathname.startsWith("/threads/")) {
    return jsonResponse(threadDetail);
  }
  if (url.pathname === "/submissions") {
    const body = jsonBody(request);
    const parsed = body === undefined ? outboundJob : JSON.parse(body);
    const requestId = Schema.decodeUnknownSync(Schema.String)(parsed.requestId);
    return jsonResponse({ ...outboundJob, requestId });
  }
  if (url.pathname === "/jobs") {
    return jsonResponse({ items: [outboundJob], nextCursor: null });
  }
  if (url.pathname.startsWith("/jobs/")) {
    return jsonResponse(outboundJob);
  }
  if (url.pathname === "/messages") {
    return request.method === "GET" ? jsonResponse(messagePage) : jsonResponse(sentMessage);
  }
  if (url.pathname.startsWith("/messages/")) {
    return jsonResponse(sentMessage);
  }
  return new Response(null, { status: 404 });
}

function capturingClient(responseFactory: CliResponseFactory = defaultResponse) {
  const captured: Array<CapturedRequest> = [];
  const httpClient = HttpClient.make((request, url) => {
    captured.push({
      method: request.method,
      url,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      origin: request.headers.origin,
      body: jsonBody(request),
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, responseFactory(request, url)));
  });
  return { captured, httpClient };
}

function unusedHttpClient() {
  return HttpClient.make(() => Effect.die("HTTP client should not be used"));
}

const unusedApprovalTokenSource = {
  readToken: () => Effect.die("ApprovalTokenSource should not be used"),
} satisfies ApprovalTokenSourceService;

function cliTestLayer() {
  return Layer.mergeAll(NodeServices.layer, Layer.fresh(TestConsole.layer));
}

function runDispatch(
  argv: ReadonlyArray<string>,
  env: CliEnv,
  httpClient: HttpClient.HttpClient,
  tokenSource: ApprovalTokenSourceService = unusedApprovalTokenSource,
  credentialStore: OAuthCredentialStoreService = testCredentialStore,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const captured = yield* runProgram(argv, env, httpClient, tokenSource, credentialStore);
      if (Exit.isFailure(captured.outcome)) {
        return yield* Effect.failCause(captured.outcome.cause);
      }
      if (captured.stdout.length === 0) {
        return yield* Effect.die("Expected JSON command output");
      }
      return JSON.parse(captured.stdout.join("\n"));
    }),
  );
}

function runProgram(
  argv: ReadonlyArray<string>,
  env: CliEnv,
  httpClient: HttpClient.HttpClient,
  tokenSource: ApprovalTokenSourceService = unusedApprovalTokenSource,
  credentialStore: OAuthCredentialStoreService = testCredentialStore,
) {
  return Effect.gen(function* () {
    const outcome = yield* Effect.exit(
      program(argv).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
      ),
    );
    const stdout = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(
      yield* TestConsole.logLines,
    );
    const stderr = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(
      yield* TestConsole.errorLines,
    );
    return { outcome, stdout, stderr };
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(ApprovalTokenSource, tokenSource),
    Effect.provideService(OAuthCredentialStore, credentialStore),
    Effect.provideService(OAuthScheduler, testScheduler),
    Effect.provide(cliTestLayer()),
  );
}

function dispatchEffect(
  argv: ReadonlyArray<string>,
  env: CliEnv,
  httpClient: HttpClient.HttpClient,
  tokenSource: ApprovalTokenSourceService = unusedApprovalTokenSource,
  credentialStore: OAuthCredentialStoreService = testCredentialStore,
) {
  return Effect.gen(function* () {
    const captured = yield* runProgram(argv, env, httpClient, tokenSource, credentialStore);
    if (Exit.isFailure(captured.outcome)) {
      return yield* Effect.failCause(captured.outcome.cause);
    }
    if (captured.stdout.length === 0) {
      return yield* Effect.die("Expected JSON command output");
    }
    return JSON.parse(captured.stdout.join("\n"));
  });
}

function approvalRedirectResponse(state: "approved" | "denied") {
  return new Response(null, {
    status: 303,
    headers: {
      location: `https://umail.example.test/approvals/${approvalTokenText}`,
      "x-umail-approval-state": state,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function approvalTokenSource(reads: Array<string | undefined>): ApprovalTokenSourceService {
  return {
    readToken: (tokenFile) =>
      Effect.sync(() => {
        reads.push(tokenFile);
        return approvalToken;
      }),
  };
}

function approvalTransportFailure(description: string) {
  return HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description }),
      }),
    ),
  );
}

interface ApprovalFailureFixture {
  readonly name: string;
  readonly httpClient: HttpClient.HttpClient;
}

function runApprovalFailure(httpClient: HttpClient.HttpClient) {
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      program(["approvals", "approve"]).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(testEnv)),
      ),
    );
    if (Result.isSuccess(result)) {
      return yield* Effect.die("Expected approval request to fail");
    }
    const stdout = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(
      yield* TestConsole.logLines,
    );
    const stderr = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(
      yield* TestConsole.errorLines,
    );
    return { failure: result.failure, stdout, stderr };
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(ApprovalTokenSource, approvalTokenSource([])),
    Effect.provideService(OAuthCredentialStore, testCredentialStore),
    Effect.provideService(OAuthScheduler, testScheduler),
    Effect.provide(cliTestLayer()),
  );
}

type ApprovalFailureCapture = Effect.Success<ReturnType<typeof runApprovalFailure>>;

function serializePublicApprovalError(failure: PublicApprovalRequestError): string {
  return JSON.stringify(failure);
}

function serializeApprovalTokenInputError(failure: ApprovalTokenInputError): string {
  return JSON.stringify(failure);
}

function serializeApprovalFailureCapture(captured: ApprovalFailureCapture): string {
  return JSON.stringify(captured);
}

describe("retained CLI dispatch", () => {
  it("dispatches every address and sending-identity operation to root routes", async () => {
    const { captured, httpClient } = capturingClient();

    await runDispatch(["addresses", "list"], testEnv, httpClient);
    await runDispatch(
      ["addresses", "create", "--local-part", "inbox", "--display-name", "Inbox"],
      testEnv,
      httpClient,
    );
    await runDispatch(["addresses", "get", "--id", "address-1"], testEnv, httpClient);
    await runDispatch(
      ["addresses", "update", "--id", "address-1", "--display-name", "Team Inbox"],
      testEnv,
      httpClient,
    );
    await runDispatch(["addresses", "enable", "--id", "address-1"], testEnv, httpClient);
    await runDispatch(["addresses", "disable", "--id", "address-1"], testEnv, httpClient);
    const identities = await runDispatch(["sending-identities", "list"], testEnv, httpClient);

    expect(captured.map(({ method, url }) => [method, url.pathname])).toEqual([
      ["GET", "/addresses"],
      ["POST", "/addresses"],
      ["GET", "/addresses/address-1"],
      ["PATCH", "/addresses/address-1"],
      ["PATCH", "/addresses/address-1"],
      ["PATCH", "/addresses/address-1"],
      ["GET", "/sending-identities"],
    ]);
    expect(JSON.parse(captured[1]?.body ?? "")).toEqual({
      localPart: "inbox",
      displayName: "Inbox",
    });
    expect(JSON.parse(captured[3]?.body ?? "")).toEqual({ displayName: "Team Inbox" });
    expect(JSON.parse(captured[4]?.body ?? "")).toEqual({ active: true });
    expect(JSON.parse(captured[5]?.body ?? "")).toEqual({ active: false });
    expect(identities).toEqual([sendingIdentity]);
  });

  it("dispatches forwarding set and remove with exact payloads", async () => {
    const { captured, httpClient } = capturingClient();

    expect(
      await runDispatch(
        ["forwarding", "set", "--address-id", "address-1", "--email", "owner@example.com"],
        testEnv,
        httpClient,
      ),
    ).toMatchObject({ verified: false });
    await runDispatch(["forwarding", "remove", "--address-id", "address-1"], testEnv, httpClient);

    expect(captured.map(({ method, url }) => [method, url.pathname])).toEqual([
      ["PUT", "/addresses/address-1/forwarding"],
      ["DELETE", "/addresses/address-1/forwarding"],
    ]);
    expect(JSON.parse(captured[0]?.body ?? "")).toEqual({ email: "owner@example.com" });
  });

  it("dispatches thread list/detail/state/delete operations and preserves query values", async () => {
    const { captured, httpClient } = capturingClient();

    const page = await runDispatch(
      ["threads", "list", "--limit", "10", "--cursor", "cursor with +/="],
      testEnv,
      httpClient,
    );
    const thread = await runDispatch(
      ["threads", "get", "--id", "thread-1", "--limit", "20", "--cursor", "cursor with +/="],
      testEnv,
      httpClient,
    );
    await runDispatch(["threads", "read", "--id", "thread-1"], testEnv, httpClient);
    await runDispatch(["threads", "unread", "--id", "thread-1"], testEnv, httpClient);
    await runDispatch(["threads", "delete", "--id", "thread-1"], testEnv, httpClient);

    expect(captured.map(({ method, url }) => [method, url.pathname])).toEqual([
      ["GET", "/threads"],
      ["GET", "/threads/thread-1"],
      ["PATCH", "/threads/thread-1/read"],
      ["PATCH", "/threads/thread-1/unread"],
      ["DELETE", "/threads/thread-1"],
    ]);
    expect(captured[0]?.url.searchParams.get("limit")).toBe("10");
    expect(captured[0]?.url.searchParams.get("cursor")).toBe("cursor with +/=");
    expect(captured[1]?.url.searchParams.get("limit")).toBe("20");
    expect(captured[1]?.url.searchParams.get("cursor")).toBe("cursor with +/=");
    expect(page).toEqual(threadPage);
    expect(thread).toEqual(threadDetail);
  });

  it("submits compose and reply jobs with actor-free request bodies and visible ids", async () => {
    const { captured, httpClient } = capturingClient();

    const composed = await runDispatch(
      [
        "messages",
        "compose",
        "--from",
        " Inbox@UMAIL.EXAMPLE.TEST ",
        "--subject",
        "Hello",
        "--to",
        "alice@example.com",
        "--to",
        "bob@example.com",
        "--cc",
        "copy@example.com",
        "--text",
        "Hi",
        "--request-id",
        REQUEST_ID,
      ],
      testEnv,
      httpClient,
    );
    const replied = await runDispatch(
      [
        "messages",
        "reply",
        "--from",
        "inbox@umail.example.test",
        "--subject",
        "Re: Hello",
        "--reply-to",
        "message-in-1",
        "--reply-all",
        "--html",
        "<p>Thanks</p>",
        "--request-id",
        REQUEST_ID,
      ],
      testEnv,
      httpClient,
    );

    expect(captured.map(({ method, url }) => [method, url.pathname])).toEqual([
      ["GET", "/sending-identities"],
      ["POST", "/submissions"],
      ["GET", "/sending-identities"],
      ["POST", "/submissions"],
    ]);
    expect(JSON.parse(captured[1]?.body ?? "")).toEqual({
      intent: "compose",
      requestId: REQUEST_ID,
      fromAddressId: "address-1",
      subject: "Hello",
      to: [
        { address: "alice@example.com", displayName: null },
        { address: "bob@example.com", displayName: null },
      ],
      cc: [{ address: "copy@example.com", displayName: null }],
      text: "Hi",
    });
    expect(JSON.parse(captured[3]?.body ?? "")).toEqual({
      intent: "reply",
      requestId: REQUEST_ID,
      fromAddressId: "address-1",
      subject: "Re: Hello",
      replyToMessageId: "message-in-1",
      replyMode: "reply-all",
      html: "<p>Thanks</p>",
    });
    expect(composed).toMatchObject({ jobId: "job-1", requestId: REQUEST_ID, state: "ready" });
    expect(replied).toMatchObject({ jobId: "job-1", requestId: REQUEST_ID, state: "ready" });
  });

  it("accepts equals syntax for repeated recipients", async () => {
    const { captured, httpClient } = capturingClient();

    await runDispatch(
      [
        "messages",
        "compose",
        "--from=inbox@umail.example.test",
        "--subject=Hello",
        "--to=alice@example.com",
        "--to=bob@example.com",
        "--text=Hi",
        `--request-id=${REQUEST_ID}`,
      ],
      testEnv,
      httpClient,
    );

    expect(JSON.parse(captured[1]?.body ?? "")).toEqual({
      intent: "compose",
      requestId: REQUEST_ID,
      fromAddressId: "address-1",
      subject: "Hello",
      to: [
        { address: "alice@example.com", displayName: null },
        { address: "bob@example.com", displayName: null },
      ],
      text: "Hi",
    });
  });

  it("reuses a generated request id across automatic transport retries", async () => {
    const captured: Array<CapturedRequest> = [];
    let submissionAttempts = 0;
    const httpClient = HttpClient.make((request, url) => {
      captured.push({
        method: request.method,
        url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        origin: request.headers.origin,
        body: jsonBody(request),
      });
      if (url.pathname === "/sending-identities") {
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse([sendingIdentity])));
      }
      if (url.pathname === "/submissions") {
        submissionAttempts += 1;
        if (submissionAttempts === 1) {
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "temporary",
              }),
            }),
          );
        }
        const body = jsonBody(request);
        const parsed = body === undefined ? outboundJob : JSON.parse(body);
        const requestId = Schema.decodeUnknownSync(Schema.String)(parsed.requestId);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, jsonResponse({ ...outboundJob, requestId })),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
      );
    });

    const result = await runDispatch(
      [
        "messages",
        "compose",
        "--from",
        "inbox@umail.example.test",
        "--subject",
        "Hello",
        "--to",
        "bob@example.com",
        "--text",
        "Hi",
      ],
      testEnv,
      httpClient,
    );

    const firstBody = JSON.parse(captured[1]?.body ?? "");
    const secondBody = JSON.parse(captured[2]?.body ?? "");
    expect(firstBody.requestId).toEqual(secondBody.requestId);
    expect(firstBody.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
    expect(result).toMatchObject({ requestId: firstBody.requestId, state: "ready" });
    expect(submissionAttempts).toBe(2);
  });

  it("lists and gets job status", async () => {
    const { captured, httpClient } = capturingClient();
    const page = await runDispatch(["jobs", "list", "--limit", "5"], testEnv, httpClient);
    const job = await runDispatch(["jobs", "get", "--id", "job-1"], testEnv, httpClient);
    expect(captured.map(({ method, url }) => [method, url.pathname])).toEqual([
      ["GET", "/jobs"],
      ["GET", "/jobs/job-1"],
    ]);
    expect(captured[0]?.url.searchParams.get("limit")).toBe("5");
    expect(page).toEqual({ items: [outboundJob], nextCursor: null });
    expect(job).toEqual(outboundJob);
  });

  it("writes attachment bytes to the requested file and returns safe metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "umail-cli-attachment-"));
    const output = join(directory, "message.txt");
    const bytes = new TextEncoder().encode("attachment bytes");
    const { captured, httpClient } = capturingClient(
      () =>
        new Response(bytes, {
          headers: {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="message.txt"',
            "x-content-type-options": "nosniff",
          },
        }),
    );
    try {
      const result = await runDispatch(
        [
          "attachments",
          "get",
          "--id",
          "message-1",
          "--attachment-id",
          "attachment-1",
          "--output",
          output,
        ],
        testEnv,
        httpClient,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0]?.method).toBe("GET");
      expect(captured[0]?.url.pathname).toBe("/messages/message-1/attachments/attachment-1");
      expect(readFileSync(output, "utf8")).toBe("attachment bytes");
      expect(result).toEqual({ output, bytes: bytes.byteLength, contentType: "text/plain" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes the exact archived message source to the requested file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "umail-cli-source-"));
    const output = join(directory, "message-1.eml");
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode("Subject: hi\r\n\r\n"),
      0x00,
      0xff,
      0x0d,
      0x0a,
    ]);
    const { captured, httpClient } = capturingClient(
      () =>
        new Response(bytes, {
          headers: {
            "content-type": "message/rfc822",
            "content-disposition": 'attachment; filename="message-1.eml"',
            "x-content-type-options": "nosniff",
          },
        }),
    );
    try {
      const result = await runDispatch(
        ["messages", "source", "--id", "message-1", "--output", output],
        testEnv,
        httpClient,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0]?.method).toBe("GET");
      expect(captured[0]?.url.pathname).toBe("/messages/message-1/source");
      expect(captured[0]?.authorization).toBe("Bearer test-oauth-access-token");
      expect(new Uint8Array(readFileSync(output))).toEqual(bytes);
      expect(result).toEqual({ output, bytes: bytes.byteLength, contentType: "message/rfc822" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed or ineligible senders before sending", async () => {
    const malformed = await Effect.runPromise(
      runProgram(
        [
          "messages",
          "compose",
          "--from",
          "not an address",
          "--subject",
          "Hello",
          "--to",
          "bob@example.com",
          "--text",
          "Hi",
        ],
        testEnv,
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(malformed.outcome)).toBe(true);
    expect(malformed.stderr.join("\n")).toContain("--from");
    expect(malformed.stderr.join("\n")).toContain("valid mailbox address");

    const { captured, httpClient } = capturingClient((request, url) =>
      url.pathname === "/sending-identities" ? jsonResponse([]) : jsonResponse(outboundJob),
    );
    await expect(
      runDispatch(
        [
          "messages",
          "compose",
          "--from",
          "inbox@umail.example.test",
          "--subject",
          "Hello",
          "--to",
          "bob@example.com",
          "--text",
          "Hi",
        ],
        testEnv,
        httpClient,
      ),
    ).rejects.toThrow("No eligible sending identity matches --from: inbox@umail.example.test");
    expect(captured).toHaveLength(1);
  });

  it("rejects invalid recipients, missing values, and overflow dates without sending", async () => {
    const invalidRecipient = await Effect.runPromise(
      runProgram(
        [
          "messages",
          "compose",
          "--from",
          "inbox@umail.example.test",
          "--subject",
          "Hello",
          "--to",
          "not-an-address",
          "--text",
          "Hi",
        ],
        testEnv,
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(invalidRecipient.outcome)).toBe(true);
    expect(invalidRecipient.stderr.join("\n")).toContain("not-an-address");

    const missingTo = await Effect.runPromise(
      runProgram(
        [
          "messages",
          "compose",
          "--from",
          "inbox@umail.example.test",
          "--subject",
          "Hello",
          "--text",
          "Hi",
          "--to",
        ],
        testEnv,
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(missingTo.outcome)).toBe(true);
    expect(missingTo.stderr.join("\n")).toMatch(/--to/u);

    const overflow = await Effect.runPromise(
      runProgram(
        ["messages", "list", "--since", "+275760-09-13T00:00:00.000Z"],
        testEnv,
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(overflow.outcome)).toBe(true);
    expect(overflow.stderr.join("\n")).toContain("--since");

    const hoursOverflow = await Effect.runPromise(
      runProgram(["messages", "list", "--since-hours", "3000000000"], testEnv, unusedHttpClient()),
    );
    expect(Exit.isFailure(hoursOverflow.outcome)).toBe(true);
    expect(hoursOverflow.stderr).toEqual(["--since-hours produced a date outside years 1-9999"]);

    const conflicting = await Effect.runPromise(
      runProgram(
        ["messages", "list", "--since", "2026-08-25T00:00:00.000Z", "--since-hours", "24"],
        testEnv,
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(conflicting.outcome)).toBe(true);
    expect(conflicting.stderr.join("\n")).toContain("--since and --since-hours");
  });

  it("rejects mutually exclusive compose and reply options before credentials or HTTP", async () => {
    const send = await Effect.runPromise(
      runProgram(
        [
          "messages",
          "send",
          "--from",
          "inbox@umail.example.test",
          "--subject",
          "Hello",
          "--to",
          "bob@example.com",
          "--text",
          "Hi",
        ],
        testEnv,
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(send.outcome)).toBe(true);
    expect(send.stderr.join("\n").toLowerCase()).toContain("unknown subcommand");

    const composeReplyTo = await Effect.runPromise(
      runProgram(
        [
          "messages",
          "compose",
          "--from",
          "inbox@umail.example.test",
          "--subject",
          "Hello",
          "--to",
          "bob@example.com",
          "--text",
          "Hi",
          "--reply-to",
          "message-in-1",
        ],
        testEnv,
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(composeReplyTo.outcome)).toBe(true);
    expect(composeReplyTo.stderr.join("\n")).toContain("--reply-to");

    const replyTo = await Effect.runPromise(
      runProgram(
        [
          "messages",
          "reply",
          "--from",
          "inbox@umail.example.test",
          "--subject",
          "Re: Hello",
          "--reply-to",
          "message-in-1",
          "--to",
          "bob@example.com",
          "--text",
          "Hi",
        ],
        testEnv,
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(replyTo.outcome)).toBe(true);
    expect(replyTo.stderr.join("\n")).toContain("--to");
  });

  it("dispatches message list/get with query mapping and local --since-hours", async () => {
    const { captured, httpClient } = capturingClient();

    const page = await runDispatch(
      [
        "messages",
        "list",
        "--direction",
        "inbound",
        "--address-id",
        "address-1",
        "--since",
        "2026-08-25T00:00:00.000Z",
        "--unread",
        "--limit",
        "10",
        "--cursor",
        "cursor with +/=",
      ],
      testEnv,
      httpClient,
    );
    const message = await runDispatch(
      ["messages", "get", "--id", "message-1"],
      testEnv,
      httpClient,
    );

    expect(captured.map(({ method, url }) => [method, url.pathname])).toEqual([
      ["GET", "/messages"],
      ["GET", "/messages/message-1"],
    ]);
    expect(captured[0]?.url.searchParams.get("direction")).toBe("inbound");
    expect(captured[0]?.url.searchParams.get("addressId")).toBe("address-1");
    expect(captured[0]?.url.searchParams.get("since")).toBe("2026-08-25T00:00:00.000Z");
    expect(captured[0]?.url.searchParams.get("unread")).toBe("true");
    expect(captured[0]?.url.searchParams.get("limit")).toBe("10");
    expect(captured[0]?.url.searchParams.get("cursor")).toBe("cursor with +/=");
    expect(captured[0]?.url.searchParams.has("until")).toBe(false);
    expect(page).toEqual(messagePage);
    expect(message).toEqual(sentMessage);

    const inboundClient = capturingClient((_request, url) => {
      if (url.pathname === "/messages") {
        return jsonResponse({ items: [receivedMessage], nextCursor: null });
      }
      return jsonResponse(receivedMessage);
    });
    const inboundPage = await runDispatch(
      ["messages", "list", "--direction", "inbound"],
      testEnv,
      inboundClient.httpClient,
    );
    const inboundMessage = await runDispatch(
      ["messages", "get", "--id", "received-1"],
      testEnv,
      inboundClient.httpClient,
    );
    expect(inboundPage.items[0]).toMatchObject({
      envelopeFrom: "",
      envelopeTo: "inbox@umail.example.test",
      parsedDate: "2026-08-25T10:00:00.000Z",
      forwardOutcome: "failure",
      forwardDestination: "forward@example.net",
    });
    expect(inboundMessage).toMatchObject({
      envelopeFrom: "",
      envelopeTo: "inbox@umail.example.test",
      parsedDate: "2026-08-25T10:00:00.000Z",
      forwardOutcome: "failure",
      forwardDestination: "forward@example.net",
    });

    const sinceHoursClient = capturingClient();
    await runDispatch(
      ["messages", "list", "--since-hours", "24"],
      testEnv,
      sinceHoursClient.httpClient,
    );
    const since = sinceHoursClient.captured[0]?.url.searchParams.get("since");
    expect(since).toEqual(expect.any(String));
    expect(Math.abs(Date.parse(since ?? "") - (Date.now() - 24 * 60 * 60 * 1000))).toBeLessThan(
      5000,
    );
    expect(sinceHoursClient.captured[0]?.url.searchParams.has("until")).toBe(false);
  });
});

describe("public approval capability commands", () => {
  it.effect("uses the masked-input and token-file sources without bearer configuration", () =>
    Effect.gen(function* () {
      const reads: Array<string | undefined> = [];
      const { captured, httpClient } = capturingClient((_request, url) =>
        approvalRedirectResponse(url.pathname.endsWith("/approve") ? "denied" : "approved"),
      );
      const source = approvalTokenSource(reads);

      const approve = yield* dispatchEffect(
        ["approvals", "approve"],
        { UMAIL_URL: testEnv.UMAIL_URL },
        httpClient,
        source,
      );
      const deny = yield* dispatchEffect(
        ["approvals", "deny", "--token-file", "/run/secrets/umail-approval"],
        { UMAIL_URL: testEnv.UMAIL_URL },
        httpClient,
        source,
      );

      expect(reads).toEqual([undefined, "/run/secrets/umail-approval"]);
      expect(approve).toEqual({ state: "denied" });
      expect(deny).toEqual({ state: "approved" });
      expect(captured.map(({ method, url }) => [method, url.pathname])).toEqual([
        ["POST", `/approvals/${approvalTokenText}/approve`],
        ["POST", `/approvals/${approvalTokenText}/deny`],
      ]);
      for (const request of captured) {
        expect(request.authorization).toBeUndefined();
        expect(request.contentType).toBeUndefined();
        expect(request.origin).toBeUndefined();
        expect(request.body).toBeUndefined();
      }
    }),
  );

  it.effect(
    "reads a token file with one conventional line ending and rejects unsafe input exactly",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "umail-approval-token-"));
      const tokenPath = join(directory, "approval-token");
      const invalidPath = join(directory, "invalid-token");
      const invalidToken = "not-a-valid-secret-token";
      writeFileSync(tokenPath, `${approvalTokenText}\r\n`, { mode: 0o600 });
      writeFileSync(invalidPath, `${invalidToken}\n\n`, { mode: 0o600 });
      const layer = ApprovalTokenSource.layer.pipe(Layer.provide(NodeServices.layer));
      const readToken = (path: string) =>
        Effect.gen(function* () {
          const source = yield* ApprovalTokenSource;
          return yield* source.readToken(path);
        }).pipe(Effect.result, Effect.provide(layer));

      return Effect.gen(function* () {
        const token = yield* readToken(tokenPath);
        if (Result.isFailure(token)) {
          throw token.failure;
        }
        expect(token.success).toBe(approvalTokenText);

        const invalid = yield* readToken(invalidPath);
        if (Result.isSuccess(invalid)) {
          throw new Error("Expected invalid token file to fail");
        }
        expect(invalid.failure).toEqual(new ApprovalTokenInputError({ reason: "invalid" }));
        for (const rendered of [
          invalid.failure.message,
          invalid.failure.stack ?? "",
          String(invalid.failure),
          inspect(invalid.failure),
          formatCliError(invalid.failure),
        ]) {
          expect(rendered).not.toContain(invalidToken);
          expect(rendered).not.toContain(invalidPath);
        }

        const missingPath = join(directory, "missing-token");
        const unreadable = yield* readToken(missingPath);
        if (Result.isSuccess(unreadable)) {
          throw new Error("Expected missing token file to fail");
        }
        expect(unreadable.failure).toEqual(new ApprovalTokenInputError({ reason: "unreadable" }));
        for (const rendered of [
          unreadable.failure.message,
          unreadable.failure.stack ?? "",
          String(unreadable.failure),
          inspect(unreadable.failure),
          serializeApprovalTokenInputError(unreadable.failure),
          formatCliError(unreadable.failure),
        ]) {
          expect(rendered).not.toContain(missingPath);
        }
      }).pipe(
        Effect.ensuring(Effect.sync(() => rmSync(directory, { force: true, recursive: true }))),
      );
    },
  );

  it.effect("collapses every public client failure without retaining its URL or token", () =>
    Effect.gen(function* () {
      const maliciousBody = `<p>${testEnv.UMAIL_URL}/approvals/${approvalTokenText}</p>`;
      const responseClient = (response: Response) => capturingClient(() => response).httpClient;
      const fixtures: ReadonlyArray<ApprovalFailureFixture> = [
        {
          name: "typed 404",
          httpClient: responseClient(
            new Response(maliciousBody, { status: 404, headers: approvalTrustedHeaders }),
          ),
        },
        {
          name: "typed 410",
          httpClient: responseClient(
            new Response(maliciousBody, { status: 410, headers: approvalTrustedHeaders }),
          ),
        },
        {
          name: "unexpected status",
          httpClient: responseClient(
            new Response(maliciousBody, {
              status: 500,
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
        },
        {
          name: "transport",
          httpClient: approvalTransportFailure(`transport at ${testEnv.UMAIL_URL}`),
        },
        {
          name: "timeout",
          httpClient: approvalTransportFailure(
            `timeout for ${testEnv.UMAIL_URL}/approvals/${approvalTokenText}`,
          ),
        },
        {
          name: "response decoding",
          httpClient: responseClient(
            new Response(null, {
              status: 303,
              headers: {
                location: `${testEnv.UMAIL_URL}/approvals/${approvalTokenText}`,
                "x-umail-approval-state": "not-a-decision",
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
              },
            }),
          ),
        },
      ];

      for (const fixture of fixtures) {
        const captured = yield* runApprovalFailure(fixture.httpClient);
        const failure = captured.failure;
        expect(failure, fixture.name).toEqual(new PublicApprovalRequestError());
        expect(failure, fixture.name).not.toHaveProperty("cause");
        if (!(failure instanceof PublicApprovalRequestError)) {
          throw new Error(`Expected owner-specific approval failure for ${fixture.name}`);
        }
        const rendered = [
          failure.message,
          failure.name,
          failure.stack ?? "",
          String(failure),
          serializePublicApprovalError(failure),
          inspect(failure),
          formatCliError(failure),
        ];
        for (const output of rendered) {
          expect(output, fixture.name).not.toContain(approvalTokenText);
          expect(output, fixture.name).not.toContain(testEnv.UMAIL_URL);
        }
        expect(formatCliError(failure), fixture.name).toBe(
          "Could not complete the approval request.",
        );
        expect(captured.stdout, fixture.name).toEqual([]);
        expect(captured.stderr, fixture.name).toEqual(["Could not complete the approval request."]);
        expect(serializeApprovalFailureCapture(captured), fixture.name).not.toContain(
          approvalTokenText,
        );
        expect(serializeApprovalFailureCapture(captured), fixture.name).not.toContain(
          testEnv.UMAIL_URL,
        );
      }
    }),
  );

  it.effect("does not contact the public client when token input fails", () => {
    const source = {
      readToken: () => Effect.fail(new ApprovalTokenInputError({ reason: "invalid" })),
    } satisfies ApprovalTokenSourceService;

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        dispatchEffect(
          ["approvals", "approve"],
          { UMAIL_URL: testEnv.UMAIL_URL },
          unusedHttpClient(),
          source,
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toEqual(new ApprovalTokenInputError({ reason: "invalid" }));
      }
      expect(formatCliError(new ApprovalTokenInputError({ reason: "invalid" }))).toBe(
        "Approval token must be 64 lowercase hexadecimal characters",
      );
    });
  });
});

describe("removed CLI surface and safe errors", () => {
  it("rejects removed commands before configuration or network access", async () => {
    for (const argv of [
      ["bootstrap"],
      ["users", "list"],
      ["api-keys", "list"],
      ["keys", "list"],
      ["approvals", "list"],
      ["clients", "list"],
    ] as const) {
      const captured = await Effect.runPromise(runProgram(argv, testEnv, unusedHttpClient()));
      expect(Exit.isFailure(captured.outcome)).toBe(true);
      expect(captured.stderr.join("\n").toLowerCase()).toContain("unknown subcommand");
    }
  });

  it("rejects every removed credential flag without exposing its value", async () => {
    for (const flag of [
      "--api-key",
      "--access-client-id",
      "--access-client-secret",
      "--secret",
    ] as const) {
      const captured = await Effect.runPromise(
        runProgram(["addresses", "list", flag, "must-not-render"], testEnv, unusedHttpClient()),
      );
      expect(Exit.isFailure(captured.outcome)).toBe(true);
      expect(captured.stderr.join("\n")).toContain(flag);
      expect(`${captured.stdout.join("")}${captured.stderr.join("")}`).not.toContain(
        "must-not-render",
      );
    }
    const equals = await Effect.runPromise(
      runProgram(["addresses", "list", "--api-key=must-not-render"], testEnv, unusedHttpClient()),
    );
    expect(Exit.isFailure(equals.outcome)).toBe(true);
    expect(equals.stderr.join("\n")).toContain("--api-key");
    expect(`${equals.stdout.join("")}${equals.stderr.join("")}`).not.toContain("must-not-render");
    const approvalKey = await Effect.runPromise(
      runProgram(
        ["approvals", "approve", "--api-key", "must-not-render"],
        testEnv,
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(approvalKey.outcome)).toBe(true);
    expect(approvalKey.stderr.join("\n")).toContain("--api-key");
    const tokenFlag = await Effect.runPromise(
      runProgram(
        ["approvals", "approve", "--token", "must-not-render"],
        { UMAIL_URL: testEnv.UMAIL_URL },
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(tokenFlag.outcome)).toBe(true);
    expect(tokenFlag.stderr.join("\n")).toContain("--token");
    const missingTokenFile = await Effect.runPromise(
      runProgram(
        ["approvals", "approve", "--token-file"],
        { UMAIL_URL: testEnv.UMAIL_URL },
        unusedHttpClient(),
      ),
    );
    expect(Exit.isFailure(missingTokenFile.outcome)).toBe(true);
    expect(missingTokenFile.stderr.join("\n")).toContain("--token-file");
  });

  it.effect("lists only retained commands and options in help", () =>
    Effect.gen(function* () {
      const root = yield* runProgram(["--help"], testEnv, unusedHttpClient());
      const messages = yield* runProgram(["messages", "--help"], testEnv, unusedHttpClient());
      const reply = yield* runProgram(["messages", "reply", "--help"], testEnv, unusedHttpClient());
      const compose = yield* runProgram(
        ["messages", "compose", "--help"],
        testEnv,
        unusedHttpClient(),
      );
      const approvals = yield* runProgram(
        ["approvals", "approve", "--help"],
        testEnv,
        unusedHttpClient(),
      );
      const deny = yield* runProgram(["approvals", "deny", "--help"], testEnv, unusedHttpClient());
      const addresses = yield* runProgram(
        ["addresses", "create", "--help"],
        testEnv,
        unusedHttpClient(),
      );
      const help = [
        ...root.stdout,
        ...messages.stdout,
        ...reply.stdout,
        ...compose.stdout,
        ...approvals.stdout,
        ...deny.stdout,
        ...addresses.stdout,
      ].join("\n");
      for (const retained of [
        "login",
        "logout",
        "addresses",
        "sending-identities",
        "forwarding",
        "threads",
        "jobs",
        "compose",
        "reply",
        "attachments",
        "approve",
        "deny",
        "--token-file",
        "masked prompt",
        "--reply-all",
        "--local-part",
        "--request-id",
        "browser device flow",
        "Revoke this CLI's access on the server",
      ] as const) {
        expect(help).toContain(retained);
      }
      const lowerHelp = help.toLowerCase();
      for (const removed of [
        "bootstrap",
        "users",
        "api-keys",
        "keys",
        "password",
        "role",
        "access-client",
        "--api-key",
        "--secret",
        "approvals list",
        "set-policy",
        "mcp oauth clients",
        "destinations",
        "better-auth",
        "messages send",
      ] as const) {
        expect(lowerHelp).not.toContain(removed);
      }
      expect(help).not.toMatch(/--token(?=[\s<])/u);
    }),
  );

  it("prints each failure once and stays silent on interruption", async () => {
    const unconfigured = await Effect.runPromise(
      runProgram(["threads", "list"], {}, unusedHttpClient()),
    );
    expect(Exit.isFailure(unconfigured.outcome)).toBe(true);
    expect(unconfigured.stdout).toEqual([]);
    expect(unconfigured.stderr).toEqual(["UMAIL_URL is required"]);

    const usage = await Effect.runPromise(
      runProgram(
        [
          "messages",
          "compose",
          "--from",
          "not an address",
          "--subject",
          "s",
          "--to",
          "bob@example.com",
          "--text",
          "t",
        ],
        testEnv,
        unusedHttpClient(),
      ),
    );
    expect(usage.stderr.join("\n").match(/valid mailbox address/gu)).toHaveLength(1);

    const interrupted = await Effect.runPromise(
      runProgram(
        ["threads", "list"],
        testEnv,
        HttpClient.make(() => Effect.interrupt),
      ),
    );
    expect(Exit.hasInterrupts(interrupted.outcome)).toBe(true);
    expect(interrupted.stderr).toEqual([]);
  });

  it("formats HTTP and API errors without request credentials", () => {
    const keyValue = "root-key-that-must-not-render";
    const request = HttpClientRequest.get("https://umail.example.test/addresses").pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${keyValue}`),
    );
    const response = HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }));
    const formatted = formatCliError(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.StatusCodeError({ request, response }),
      }),
    );

    expect(formatted).toContain("401");
    expect(formatted).not.toContain(keyValue);
    expect(formatCliError(new HttpApiError.NotFound())).toBe("NotFound");
  });
});
