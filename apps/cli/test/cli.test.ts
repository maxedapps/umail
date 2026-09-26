import { inspect } from "node:util";

import { ApprovalToken, NotFound } from "@umail/api-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type { Json } from "effect/Schema";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import * as Command from "effect/unstable/cli/Command";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { OAuthScheduler, type OAuthSchedulerService } from "../src/auth.ts";
import { OAuthCredentialStore, type OAuthCredentialStoreService } from "../src/credential-store.ts";
import {
  ApprovalTokenInputError,
  ApprovalTokenSource,
  type ApprovalTokenSourceService,
} from "../src/approvals.ts";
import { umailCommand } from "../src/commands/index.ts";
import { renderCause, program } from "../src/main.ts";

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
    // An hour after the TestClock's start at the epoch.
    expiresAt: 3_600_000,
  }),
  write: () => Effect.void,
  remove: Effect.void,
  withLock: (body) => body,
} satisfies OAuthCredentialStoreService;

const testScheduler = {
  now: Clock.currentTimeMillis,
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

const JsonString = Schema.fromJsonString(Schema.Json);

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

const SubmittedRequest = Schema.fromJsonString(Schema.Struct({ requestId: Schema.String }));

// Echoes the submitted request id back in the job, as the server does.
function submissionResponse(request: HttpClientRequest.HttpClientRequest) {
  const body = jsonBody(request);
  const requestId =
    body === undefined
      ? outboundJob.requestId
      : Schema.decodeSync(SubmittedRequest)(body).requestId;
  return jsonResponse({ ...outboundJob, requestId });
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
    return submissionResponse(request);
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

function runProgram(
  argv: ReadonlyArray<string>,
  env: CliEnv,
  httpClient: HttpClient.HttpClient,
  tokenSource: ApprovalTokenSourceService = unusedApprovalTokenSource,
  credentialStore: OAuthCredentialStoreService = testCredentialStore,
) {
  return Effect.gen(function* () {
    const outcome = yield* Effect.exit(
      program(umailCommand, argv).pipe(
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
    return yield* Schema.decodeEffect(JsonString)(captured.stdout.join("\n"));
  });
}

// Decodes the JSON body the CLI sent with a captured request.
function requestJson(request: CapturedRequest | undefined) {
  return Schema.decodeEffect(JsonString)(request?.body ?? "");
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
  readonly expected: string;
}

function runApprovalFailure(httpClient: HttpClient.HttpClient) {
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      program(umailCommand, ["approvals", "approve"]).pipe(
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

// What the CLI prints for a failure.
function rendered(error: unknown): string | null {
  return renderCause(Cause.fail(error));
}

function serializePublicApprovalError(failure: Error): string {
  return JSON.stringify(failure);
}

function serializeApprovalTokenInputError(failure: ApprovalTokenInputError): string {
  return JSON.stringify(failure);
}

function serializeApprovalFailureCapture(captured: ApprovalFailureCapture): string {
  return JSON.stringify(captured);
}

layer(NodeServices.layer)("retained CLI dispatch", (it) => {
  it.effect("dispatches every address and sending-identity operation to root routes", () =>
    Effect.gen(function* () {
      const { captured, httpClient } = capturingClient();

      yield* dispatchEffect(["addresses", "list"], testEnv, httpClient);
      yield* dispatchEffect(
        ["addresses", "create", "--local-part", "inbox", "--display-name", "Inbox"],
        testEnv,
        httpClient,
      );
      yield* dispatchEffect(["addresses", "get", "--id", "address-1"], testEnv, httpClient);
      yield* dispatchEffect(
        ["addresses", "update", "--id", "address-1", "--display-name", "Team Inbox"],
        testEnv,
        httpClient,
      );
      yield* dispatchEffect(["addresses", "enable", "--id", "address-1"], testEnv, httpClient);
      yield* dispatchEffect(["addresses", "disable", "--id", "address-1"], testEnv, httpClient);
      const identities = yield* dispatchEffect(["sending-identities", "list"], testEnv, httpClient);

      expect(captured.map(({ method, url }) => [method, url.pathname])).toEqual([
        ["GET", "/addresses"],
        ["POST", "/addresses"],
        ["GET", "/addresses/address-1"],
        ["PATCH", "/addresses/address-1"],
        ["PATCH", "/addresses/address-1"],
        ["PATCH", "/addresses/address-1"],
        ["GET", "/sending-identities"],
      ]);
      expect(yield* requestJson(captured[1])).toEqual({
        localPart: "inbox",
        displayName: "Inbox",
      });
      expect(yield* requestJson(captured[3])).toEqual({ displayName: "Team Inbox" });
      expect(yield* requestJson(captured[4])).toEqual({ active: true });
      expect(yield* requestJson(captured[5])).toEqual({ active: false });
      expect(identities).toEqual([sendingIdentity]);
    }),
  );

  it.effect("dispatches forwarding set and remove with exact payloads", () =>
    Effect.gen(function* () {
      const { captured, httpClient } = capturingClient();

      expect(
        yield* dispatchEffect(
          ["forwarding", "set", "--address-id", "address-1", "--email", "owner@example.com"],
          testEnv,
          httpClient,
        ),
      ).toMatchObject({ verified: false });
      yield* dispatchEffect(
        ["forwarding", "remove", "--address-id", "address-1"],
        testEnv,
        httpClient,
      );

      expect(captured.map(({ method, url }) => [method, url.pathname])).toEqual([
        ["PUT", "/addresses/address-1/forwarding"],
        ["DELETE", "/addresses/address-1/forwarding"],
      ]);
      expect(yield* requestJson(captured[0])).toEqual({ email: "owner@example.com" });
    }),
  );

  it.effect(
    "dispatches thread list/detail/state/delete operations and preserves query values",
    () =>
      Effect.gen(function* () {
        const { captured, httpClient } = capturingClient();

        const page = yield* dispatchEffect(
          ["threads", "list", "--limit", "10", "--cursor", "cursor with +/="],
          testEnv,
          httpClient,
        );
        const thread = yield* dispatchEffect(
          ["threads", "get", "--id", "thread-1", "--limit", "20", "--cursor", "cursor with +/="],
          testEnv,
          httpClient,
        );
        yield* dispatchEffect(["threads", "read", "--id", "thread-1"], testEnv, httpClient);
        yield* dispatchEffect(["threads", "unread", "--id", "thread-1"], testEnv, httpClient);
        yield* dispatchEffect(["threads", "delete", "--id", "thread-1"], testEnv, httpClient);

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
      }),
  );

  it.effect("submits compose and reply jobs with actor-free request bodies and visible ids", () =>
    Effect.gen(function* () {
      const { captured, httpClient } = capturingClient();

      const composed = yield* dispatchEffect(
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
      const replied = yield* dispatchEffect(
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
      expect(yield* requestJson(captured[1])).toEqual({
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
      expect(yield* requestJson(captured[3])).toEqual({
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
    }),
  );

  it.effect("accepts equals syntax for repeated recipients", () =>
    Effect.gen(function* () {
      const { captured, httpClient } = capturingClient();

      yield* dispatchEffect(
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

      expect(yield* requestJson(captured[1])).toEqual({
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
    }),
  );

  it.effect("reuses a generated request id across automatic transport retries", () =>
    Effect.gen(function* () {
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
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, jsonResponse([sendingIdentity])),
          );
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
          return Effect.succeed(HttpClientResponse.fromWeb(request, submissionResponse(request)));
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
        );
      });

      const result = yield* dispatchEffect(
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

      const firstBody = yield* Schema.decodeEffect(SubmittedRequest)(captured[1]?.body ?? "");
      const secondBody = yield* Schema.decodeEffect(SubmittedRequest)(captured[2]?.body ?? "");
      expect(firstBody.requestId).toEqual(secondBody.requestId);
      expect(firstBody.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
      expect(result).toMatchObject({ requestId: firstBody.requestId, state: "ready" });
      expect(submissionAttempts).toBe(2);
    }),
  );

  it.effect("lists and gets job status", () =>
    Effect.gen(function* () {
      const { captured, httpClient } = capturingClient();
      const page = yield* dispatchEffect(["jobs", "list", "--limit", "5"], testEnv, httpClient);
      const job = yield* dispatchEffect(["jobs", "get", "--id", "job-1"], testEnv, httpClient);
      expect(captured.map(({ method, url }) => [method, url.pathname])).toEqual([
        ["GET", "/jobs"],
        ["GET", "/jobs/job-1"],
      ]);
      expect(captured[0]?.url.searchParams.get("limit")).toBe("5");
      expect(page).toEqual({ items: [outboundJob], nextCursor: null });
      expect(job).toEqual(outboundJob);
    }),
  );

  it.effect("writes attachment bytes to the requested file and returns safe metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "umail-cli-attachment-" });
      const output = path.join(directory, "message.txt");
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
      const result = yield* dispatchEffect(
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
      expect(yield* fs.readFileString(output)).toBe("attachment bytes");
      expect(result).toEqual({ output, bytes: bytes.byteLength, contentType: "text/plain" });
    }),
  );

  it.effect("writes the exact archived message source to the requested file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "umail-cli-source-" });
      const output = path.join(directory, "message-1.eml");
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
      const result = yield* dispatchEffect(
        ["messages", "source", "--id", "message-1", "--output", output],
        testEnv,
        httpClient,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0]?.method).toBe("GET");
      expect(captured[0]?.url.pathname).toBe("/messages/message-1/source");
      expect(captured[0]?.authorization).toBe("Bearer test-oauth-access-token");
      expect(new Uint8Array(yield* fs.readFile(output))).toEqual(bytes);
      expect(result).toEqual({ output, bytes: bytes.byteLength, contentType: "message/rfc822" });
    }),
  );

  it.effect("rejects malformed or ineligible senders before sending", () =>
    Effect.gen(function* () {
      const malformed = yield* runProgram(
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
      );
      expect(Exit.isFailure(malformed.outcome)).toBe(true);
      expect(malformed.stderr.join("\n")).toContain("--from");
      expect(malformed.stderr.join("\n")).toContain("valid mailbox address");

      const { captured, httpClient } = capturingClient((request, url) =>
        url.pathname === "/sending-identities" ? jsonResponse([]) : jsonResponse(outboundJob),
      );
      const ineligible = yield* Effect.flip(
        dispatchEffect(
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
      );
      expect(ineligible.message).toContain(
        "No eligible sending identity matches --from: inbox@umail.example.test",
      );
      expect(captured).toHaveLength(1);
    }),
  );

  it.effect("rejects invalid recipients, missing values, and overflow dates without sending", () =>
    Effect.gen(function* () {
      const invalidRecipient = yield* runProgram(
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
      );
      expect(Exit.isFailure(invalidRecipient.outcome)).toBe(true);
      expect(invalidRecipient.stderr.join("\n")).toContain("not-an-address");

      const missingTo = yield* runProgram(
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
      );
      expect(Exit.isFailure(missingTo.outcome)).toBe(true);
      expect(missingTo.stderr.join("\n")).toMatch(/--to/u);

      const overflow = yield* runProgram(
        ["messages", "list", "--since", "+275760-09-13T00:00:00.000Z"],
        testEnv,
        unusedHttpClient(),
      );
      expect(Exit.isFailure(overflow.outcome)).toBe(true);
      expect(overflow.stderr.join("\n")).toContain("--since");

      const hoursOverflow = yield* runProgram(
        ["messages", "list", "--since-hours", "3000000000"],
        testEnv,
        unusedHttpClient(),
      );
      expect(Exit.isFailure(hoursOverflow.outcome)).toBe(true);
      expect(hoursOverflow.stderr).toEqual([
        "umail: --since-hours produced a date outside years 1-9999",
      ]);

      const conflicting = yield* runProgram(
        ["messages", "list", "--since", "2026-08-25T00:00:00.000Z", "--since-hours", "24"],
        testEnv,
        unusedHttpClient(),
      );
      expect(Exit.isFailure(conflicting.outcome)).toBe(true);
      expect(conflicting.stderr.join("\n")).toContain("--since and --since-hours");
    }),
  );

  it.effect("rejects mutually exclusive compose and reply options before credentials or HTTP", () =>
    Effect.gen(function* () {
      const send = yield* runProgram(
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
      );
      expect(Exit.isFailure(send.outcome)).toBe(true);
      expect(send.stderr.join("\n").toLowerCase()).toContain("unknown subcommand");

      const composeReplyTo = yield* runProgram(
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
      );
      expect(Exit.isFailure(composeReplyTo.outcome)).toBe(true);
      expect(composeReplyTo.stderr.join("\n")).toContain("--reply-to");

      const replyTo = yield* runProgram(
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
      );
      expect(Exit.isFailure(replyTo.outcome)).toBe(true);
      expect(replyTo.stderr.join("\n")).toContain("--to");
    }),
  );

  it.effect("dispatches message list/get with query mapping and local --since-hours", () =>
    Effect.gen(function* () {
      const { captured, httpClient } = capturingClient();

      const page = yield* dispatchEffect(
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
      const message = yield* dispatchEffect(
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
      const inboundPage = yield* dispatchEffect(
        ["messages", "list", "--direction", "inbound"],
        testEnv,
        inboundClient.httpClient,
      );
      const inboundMessage = yield* dispatchEffect(
        ["messages", "get", "--id", "received-1"],
        testEnv,
        inboundClient.httpClient,
      );
      expect(inboundPage).toMatchObject({
        items: [
          {
            envelopeFrom: "",
            envelopeTo: "inbox@umail.example.test",
            parsedDate: "2026-08-25T10:00:00.000Z",
            forwardOutcome: "failure",
            forwardDestination: "forward@example.net",
          },
        ],
      });
      expect(inboundMessage).toMatchObject({
        envelopeFrom: "",
        envelopeTo: "inbox@umail.example.test",
        parsedDate: "2026-08-25T10:00:00.000Z",
        forwardOutcome: "failure",
        forwardDestination: "forward@example.net",
      });

      const sinceHoursClient = capturingClient();
      yield* dispatchEffect(
        ["messages", "list", "--since-hours", "24"],
        testEnv,
        sinceHoursClient.httpClient,
      );
      // The TestClock starts at the epoch, so 24 hours earlier is exact.
      expect(sinceHoursClient.captured[0]?.url.searchParams.get("since")).toBe(
        "1969-12-31T00:00:00.000Z",
      );
      expect(sinceHoursClient.captured[0]?.url.searchParams.has("until")).toBe(false);
    }),
  );
});

layer(NodeServices.layer)("public approval capability commands", (it) => {
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
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "umail-approval-token-" });
        const tokenPath = path.join(directory, "approval-token");
        const invalidPath = path.join(directory, "invalid-token");
        const invalidToken = "not-a-valid-secret-token";
        yield* fs.writeFileString(tokenPath, `${approvalTokenText}\r\n`, { mode: 0o600 });
        yield* fs.writeFileString(invalidPath, `${invalidToken}\n\n`, { mode: 0o600 });
        const readToken = Effect.fn("readToken")(function* (file: string) {
          const source = yield* ApprovalTokenSource;
          return yield* source.readToken(file);
        }, Effect.provide(ApprovalTokenSource.layer));

        expect(yield* readToken(tokenPath)).toBe(approvalTokenText);

        const invalid = yield* Effect.flip(readToken(invalidPath));
        expect(invalid).toEqual(new ApprovalTokenInputError({ reason: "invalid" }));
        for (const output of [
          invalid.message,
          invalid.stack ?? "",
          String(invalid),
          inspect(invalid),
          rendered(invalid) ?? "",
        ]) {
          expect(output).not.toContain(invalidToken);
          expect(output).not.toContain(invalidPath);
        }

        const missingPath = path.join(directory, "missing-token");
        const unreadable = yield* Effect.flip(readToken(missingPath));
        expect(unreadable).toEqual(new ApprovalTokenInputError({ reason: "unreadable" }));
        for (const output of [
          unreadable.message,
          unreadable.stack ?? "",
          String(unreadable),
          inspect(unreadable),
          serializeApprovalTokenInputError(unreadable),
          rendered(unreadable) ?? "",
        ]) {
          expect(output).not.toContain(missingPath);
        }
      }),
  );

  it.effect("names each public client failure without its request URL or token", () =>
    Effect.gen(function* () {
      const maliciousBody = `<p>${testEnv.UMAIL_URL}/approvals/${approvalTokenText}</p>`;
      const responseClient = (response: Response) => capturingClient(() => response).httpClient;
      const unreachable = `Could not reach ${testEnv.UMAIL_URL} during the approval request. Check that the server is up and UMAIL_URL is right.`;
      const fixtures: ReadonlyArray<ApprovalFailureFixture> = [
        {
          name: "typed 404",
          httpClient: responseClient(
            new Response(maliciousBody, { status: 404, headers: approvalTrustedHeaders }),
          ),
          expected: "This approval token is not recognized.",
        },
        {
          name: "typed 410",
          httpClient: responseClient(
            new Response(maliciousBody, { status: 410, headers: approvalTrustedHeaders }),
          ),
          expected: "This approval is no longer available.",
        },
        {
          name: "unexpected status",
          httpClient: responseClient(
            new Response(maliciousBody, {
              status: 500,
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
          expected: "The umail server failed (HTTP 500) on the approval request. Try again later.",
        },
        {
          name: "transport",
          httpClient: approvalTransportFailure(`transport at ${testEnv.UMAIL_URL}`),
          expected: unreachable,
        },
        {
          name: "timeout",
          httpClient: approvalTransportFailure(
            `timeout for ${testEnv.UMAIL_URL}/approvals/${approvalTokenText}`,
          ),
          expected: unreachable,
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
          expected:
            "Unexpected response from the umail server: the approval request answered unreadably. Update the CLI or check UMAIL_URL.",
        },
      ];

      for (const fixture of fixtures) {
        const captured = yield* runApprovalFailure(fixture.httpClient);
        const failure = captured.failure;
        expect(failure, fixture.name).not.toHaveProperty("cause");
        if (!(failure instanceof Error)) {
          throw new Error(`Expected an approval failure for ${fixture.name}`);
        }
        expect(failure.message, fixture.name).toBe(fixture.expected);
        const outputs = [
          failure.message,
          failure.name,
          failure.stack ?? "",
          String(failure),
          serializePublicApprovalError(failure),
          inspect(failure),
          rendered(failure) ?? "",
          serializeApprovalFailureCapture(captured),
        ];
        for (const output of outputs) {
          expect(output, fixture.name).not.toContain(approvalTokenText);
          expect(output, fixture.name).not.toContain("/approvals/");
        }
        expect(captured.stdout, fixture.name).toEqual([]);
        expect(captured.stderr, fixture.name).toEqual([`umail: ${fixture.expected}`]);
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
      expect(rendered(new ApprovalTokenInputError({ reason: "invalid" }))).toBe(
        "umail: Approval token must be 64 lowercase hexadecimal characters",
      );
    });
  });
});

describe("removed CLI surface and safe errors", () => {
  it.effect("rejects removed commands before configuration or network access", () =>
    Effect.gen(function* () {
      for (const argv of [
        ["bootstrap"],
        ["users", "list"],
        ["api-keys", "list"],
        ["keys", "list"],
        ["approvals", "list"],
        ["clients", "list"],
      ] as const) {
        const captured = yield* runProgram(argv, testEnv, unusedHttpClient());
        expect(Exit.isFailure(captured.outcome)).toBe(true);
        expect(captured.stderr.join("\n").toLowerCase()).toContain("unknown subcommand");
      }
    }),
  );

  it.effect("rejects every removed credential flag without exposing its value", () =>
    Effect.gen(function* () {
      for (const flag of [
        "--api-key",
        "--access-client-id",
        "--access-client-secret",
        "--secret",
      ] as const) {
        const captured = yield* runProgram(
          ["addresses", "list", flag, "must-not-render"],
          testEnv,
          unusedHttpClient(),
        );
        expect(Exit.isFailure(captured.outcome)).toBe(true);
        expect(captured.stderr.join("\n")).toContain(flag);
        expect(`${captured.stdout.join("")}${captured.stderr.join("")}`).not.toContain(
          "must-not-render",
        );
      }
      const equals = yield* runProgram(
        ["addresses", "list", "--api-key=must-not-render"],
        testEnv,
        unusedHttpClient(),
      );
      expect(Exit.isFailure(equals.outcome)).toBe(true);
      expect(equals.stderr.join("\n")).toContain("--api-key");
      expect(`${equals.stdout.join("")}${equals.stderr.join("")}`).not.toContain("must-not-render");
      const approvalKey = yield* runProgram(
        ["approvals", "approve", "--api-key", "must-not-render"],
        testEnv,
        unusedHttpClient(),
      );
      expect(Exit.isFailure(approvalKey.outcome)).toBe(true);
      expect(approvalKey.stderr.join("\n")).toContain("--api-key");
      const tokenFlag = yield* runProgram(
        ["approvals", "approve", "--token", "must-not-render"],
        { UMAIL_URL: testEnv.UMAIL_URL },
        unusedHttpClient(),
      );
      expect(Exit.isFailure(tokenFlag.outcome)).toBe(true);
      expect(tokenFlag.stderr.join("\n")).toContain("--token");
      const missingTokenFile = yield* runProgram(
        ["approvals", "approve", "--token-file"],
        { UMAIL_URL: testEnv.UMAIL_URL },
        unusedHttpClient(),
      );
      expect(Exit.isFailure(missingTokenFile.outcome)).toBe(true);
      expect(missingTokenFile.stderr.join("\n")).toContain("--token-file");
    }),
  );

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

  it.effect("prints each failure once and stays silent on interruption", () =>
    Effect.gen(function* () {
      const unconfigured = yield* runProgram(["threads", "list"], {}, unusedHttpClient());
      expect(Exit.isFailure(unconfigured.outcome)).toBe(true);
      expect(unconfigured.stdout).toEqual([]);
      expect(unconfigured.stderr).toEqual([
        "umail: UMAIL_URL is required. Set it to your AgentMail origin, e.g. https://mail.example.com.",
      ]);

      const usage = yield* runProgram(
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
      );
      expect(usage.stderr.join("\n").match(/valid mailbox address/gu)).toHaveLength(1);

      const interrupted = yield* runProgram(
        ["threads", "list"],
        testEnv,
        HttpClient.make(() => Effect.interrupt),
      );
      expect(Exit.hasInterrupts(interrupted.outcome)).toBe(true);
      expect(interrupted.stderr).toEqual([]);
    }),
  );

  it("renders an API error as the server's sentence and a defect in full", () => {
    expect(
      rendered(
        new NotFound({
          code: "thread_not_found",
          message: "Thread t1 was not found, or it is outside this client's access.",
        }),
      ),
    ).toBe("umail: Thread t1 was not found, or it is outside this client's access.");
    expect(renderCause(Cause.die(new Error("boom")))).toContain("Error: boom");
  });
});

describe("failure messages", () => {
  const ORIGIN = testEnv.UMAIL_URL;
  const metadata = {
    issuer: `${ORIGIN}/api/auth`,
    device_authorization_endpoint: `${ORIGIN}/api/auth/device/code`,
    token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
    revocation_endpoint: `${ORIGIN}/api/auth/oauth2/revoke`,
  };
  const json = (value: Json, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const stderrOf = (
    argv: ReadonlyArray<string>,
    respond: CliResponseFactory,
    credentialStore: OAuthCredentialStoreService = testCredentialStore,
  ) =>
    Effect.map(
      runProgram(
        argv,
        testEnv,
        capturingClient(respond).httpClient,
        unusedApprovalTokenSource,
        credentialStore,
      ),
      (captured) => captured.stderr,
    );
  const refused = HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          cause: Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
        }),
      }),
    ),
  );

  it.effect("names the step and the network code when the server cannot be reached", () =>
    Effect.gen(function* () {
      const login = yield* runProgram(["login"], testEnv, refused);
      expect(login.stderr).toEqual([
        `umail: Could not reach ${ORIGIN} during discovery (ECONNREFUSED). Check that the server is up and UMAIL_URL is right.`,
      ]);
    }),
  );

  it.effect("says what the OAuth server answered and what was wrong with it", () =>
    Effect.gen(function* () {
      const expired = {
        ...testCredentialStore,
        read: Effect.map(testCredentialStore.read, (credentials) => ({
          ...credentials,
          expiresAt: 0,
        })),
      } satisfies OAuthCredentialStoreService;
      expect(
        yield* stderrOf(
          ["threads", "list"],
          (_request, url) =>
            url.pathname.startsWith("/.well-known/")
              ? json(metadata)
              : json({ error: "server_error", error_description: "database down" }, 500),
          expired,
        ),
      ).toEqual([
        "umail: OAuth token refresh failed: HTTP 500 server_error: database down. Try again; if it keeps failing, check UMAIL_URL.",
      ]);
      expect(
        yield* stderrOf(["login"], () =>
          json({ ...metadata, issuer: "https://evil.example/api/auth" }),
        ),
      ).toEqual([
        `umail: OAuth discovery failed: issuer is https://evil.example/api/auth, expected ${ORIGIN}/api/auth. Try again; if it keeps failing, check UMAIL_URL.`,
      ]);
    }),
  );

  it.effect("prints the server's own message for a declared error", () =>
    Effect.gen(function* () {
      expect(
        yield* stderrOf(["threads", "list"], () =>
          json(
            {
              _tag: "NotPermitted",
              code: "read_denied",
              message: "This client has no read access.",
            },
            403,
          ),
        ),
      ).toEqual(["umail: This client has no read access."]);
      expect(
        yield* stderrOf(["threads", "list"], () =>
          json(
            {
              _tag: "Unauthenticated",
              code: "token_invalid",
              message: "The access token is invalid or expired. Run: umail login",
            },
            401,
          ),
        ),
      ).toEqual(["umail: The access token is invalid or expired. Run: umail login"]);
    }),
  );

  it.effect("tells an undeclared status and a body outside the contract apart", () =>
    Effect.gen(function* () {
      expect(
        yield* stderrOf(["threads", "list"], () => new Response("upstream down", { status: 503 })),
      ).toEqual(["umail: The umail server failed (HTTP 503) on GET /threads. Try again later."]);
      // A 404 the contract does not declare means UMAIL_URL points somewhere else, not an outage.
      expect(
        yield* stderrOf(["threads", "list"], () => new Response("not here", { status: 404 })),
      ).toEqual([
        "umail: Unexpected response from the umail server: GET /threads answered HTTP 404. Update the CLI or check UMAIL_URL.",
      ]);
      expect(yield* stderrOf(["login"], () => new Response("not here", { status: 404 }))).toEqual([
        "umail: Unexpected response from the umail server: discovery answered HTTP 404. Update the CLI or check UMAIL_URL.",
      ]);
      expect(
        yield* stderrOf(["threads", "list"], () =>
          json({ items: [{ threadId: 7 }], nextCursor: null }),
        ),
      ).toEqual([
        "umail: Unexpected response from the umail server: items.0.threadId: Expected string. Update the CLI or check UMAIL_URL.",
      ]);
    }),
  );

  it.effect("prints the request id to retry with when a submission's outcome is unknown", () =>
    Effect.gen(function* () {
      let submissions = 0;
      const httpClient = HttpClient.make((request, url) => {
        if (url.pathname === "/sending-identities") {
          return Effect.succeed(HttpClientResponse.fromWeb(request, json([sendingIdentity])));
        }
        submissions += 1;
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        );
      });
      const captured = yield* runProgram(
        [
          "messages",
          "compose",
          "--from",
          "inbox@umail.example.test",
          "--to",
          "bob@example.com",
          "--subject",
          "Hello",
          "--text",
          "Body",
          "--request-id",
          REQUEST_ID,
        ],
        testEnv,
        httpClient,
      );
      expect(submissions).toBe(3);
      expect(captured.stderr).toEqual([
        `umail: Could not reach ${ORIGIN} during POST /submissions. Check that the server is up and UMAIL_URL is right. The submission may have been accepted. Retry with --request-id ${REQUEST_ID} and the same content to get the existing job.`,
      ]);
    }),
  );

  it.effect("reports a missing HOME while the command's services are set up", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(
        program(umailCommand.pipe(Command.provide(OAuthCredentialStore.layer)), [
          "threads",
          "list",
        ]).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(testEnv)),
          Effect.provideService(HttpClient.HttpClient, unusedHttpClient()),
          Effect.provideService(OAuthScheduler, testScheduler),
          Effect.provideService(ApprovalTokenSource, unusedApprovalTokenSource),
        ),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(yield* TestConsole.errorLines).toEqual([
        "umail: Set HOME or XDG_STATE_HOME to locate umail credentials.",
      ]);
    }).pipe(Effect.provide(cliTestLayer())),
  );
});
