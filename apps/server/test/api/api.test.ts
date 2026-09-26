import { describe, expect, it } from "@effect/vitest";
import type * as Alchemy from "alchemy";
import { RpcCallError } from "alchemy/Rpc";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import {
  AddressForwarding,
  type ApiError,
  ExternalMailAddress,
  InvalidRequest,
  MailMessagePage,
  NormalizedRfcMessageId,
  type McpPrincipal,
  type PrincipalPolicy,
  MailThreadDetail,
  MailThreadPage,
  OutboundJobStatus,
  OutboundThreadMessage,
  RequestErrors,
  SubmissionRequestId,
  SubmitMessagePayload,
  ThreadMessage,
  UmailApi,
} from "@umail/api-contract";
import type { ListMessageSummariesQuery } from "../../src/account/domain.ts";
import type { AccountStoreError } from "../../src/account/errors.ts";
import { attachmentHeaders, attachmentResponseHeaders } from "../../src/api/attachments.ts";
import { RequestErrorsLive } from "../../src/api/app.ts";
import {
  listMessages,
  listThreads,
  readMessageSource,
  submitMessage,
} from "../../src/api/operations.ts";
import { REMOTE_HTML_SOURCE, REMOTE_HTML_STORED } from "./fakes.ts";
import {
  FROM_ADDRESS,
  OPERATOR_PASSWORD,
  authorized,
  createWorld,
  jsonHeaders,
  readJson,
  readText,
  runDueWorkPass,
  seedInboundMessage,
  seedMailbox,
  unauthorized,
  type World,
} from "./world.ts";

const REQUEST_ID = Schema.decodeSync(SubmissionRequestId)("11111111-1111-4111-8111-111111111111");
const REPLY_REQUEST_ID = Schema.decodeSync(SubmissionRequestId)(
  "22222222-2222-4222-8222-222222222222",
);
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const PROVIDER_RFC_ID = Schema.decodeSync(NormalizedRfcMessageId)("<provider-1@cf.example>");

describe("API contract", () => {
  it("declares only root operational routes and no browser HTML route", () => {
    const paths: string[] = [];
    HttpApi.reflect(UmailApi, {
      onGroup() {},
      onEndpoint({ endpoint }) {
        paths.push(endpoint.path);
      },
    });
    expect(paths).toContain("/addresses");
    expect(paths).toContain("/sending-identities");
    expect(paths).toContain("/addresses/:id/forwarding");
    expect(paths).not.toContain("/forwarding-destinations");
    expect(paths).toContain("/threads");
    expect(paths).toContain("/messages");
    expect(paths).toContain("/submissions");
    expect(paths).toContain("/jobs");
    expect(paths).toContain("/messages/:id");
    expect(paths).toContain("/messages/:id/attachments/:attachmentId");
    expect(paths).toContain("/messages/:id/source");
    expect(paths).not.toContain("/keys");
    expect(paths).not.toContain("/keys/:id");
    expect(paths.some((path) => path.startsWith("/approvals/"))).toBe(false);
    expect(paths).not.toContain("/approvals");
    expect(paths.some((path) => path.startsWith("/api/"))).toBe(false);
    expect(paths.some((path) => path.endsWith("/html"))).toBe(false);
    expect(paths.some((path) => path.includes("bootstrap") || path.includes("users"))).toBe(false);
  });

  it("keeps unsafe attachments downloadable and safe images sandboxed", () => {
    const html = attachmentHeaders("text/html", "note.html");
    expect(html.contentType).toBe("application/octet-stream");
    expect(html.contentDisposition.startsWith("attachment;")).toBe(true);
    const png = attachmentResponseHeaders("image/png", "photo.png");
    expect(png["content-type"]).toBe("image/png");
    expect(png["content-disposition"].startsWith("inline;")).toBe(true);
    expect(png["content-security-policy"]).toBe("sandbox");
  });
});

describe("authoritative inbound message metadata", () => {
  it.effect(
    "returns the same envelope, parsed date, and forwarding observation on every REST read",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const mailbox = yield* seedMailbox(world);
        const inbound = yield* seedInboundMessage(world, mailbox.id, {
          id: "authoritative-inbound",
          from: "header-sender@example.com",
          to: ["visible-recipient@example.com"],
          envelopeFrom: "",
          envelopeTo: FROM_ADDRESS,
          parsedDate: "2026-08-25T10:00:00.000Z",
          occurredAt: "2026-08-25T11:00:00.000Z",
          forward: { kind: "failure", destination: "forward@example.net" },
        });

        const list = yield* Schema.decodeUnknownEffect(MailMessagePage)(
          yield* readJson(yield* world.request("http://umail.test/messages", authorized(world))),
        );
        const message = yield* Schema.decodeUnknownEffect(ThreadMessage)(
          yield* readJson(
            yield* world.request(
              `http://umail.test/messages/${inbound.messageId}`,
              authorized(world),
            ),
          ),
        );
        const thread = yield* Schema.decodeUnknownEffect(MailThreadDetail)(
          yield* readJson(
            yield* world.request(
              `http://umail.test/threads/${encodeURIComponent(inbound.threadId)}`,
              authorized(world),
            ),
          ),
        );

        const summaries = [list.items[0], message, thread.messages[0]];
        for (const summary of summaries) {
          expect(summary?.direction).toBe("inbound");
          if (summary?.direction === "inbound") {
            expect(summary).toMatchObject({
              envelopeFrom: "",
              envelopeTo: FROM_ADDRESS,
              parsedDate: "2026-08-25T10:00:00.000Z",
              occurredAt: "2026-08-25T11:00:00.000Z",
              forwardOutcome: "failure",
              forwardDestination: "forward@example.net",
            });
            expect(summary.from.map((contact) => contact.address)).toEqual([
              "header-sender@example.com",
            ]);
            expect(summary.to.map((contact) => contact.address)).toEqual([
              "visible-recipient@example.com",
            ]);
          }
        }
      }),
  );
});

describe("root authorization boundary", () => {
  it.effect.each([
    ["absent", undefined],
    ["wrong scheme", "Basic YWJjOmRlZg=="],
    ["empty", "Bearer "],
    ["garbage", "Bearer not-a-valid-credential"],
  ] as const)(
    "rejects %s credentials without exposing the access token",
    ([_name, authorization]) =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const headers = new Headers();
        if (authorization !== undefined) headers.set("authorization", authorization);
        const response = yield* world.request("http://umail.test/threads", { headers });
        expect(response.status).toBe(401);
        const body = yield* readText(response);
        expect(body).not.toContain(world.operatorAccessToken);
        expect(body).not.toContain(OPERATOR_PASSWORD);
      }),
  );

  it.effect("tells a caller with a bad token to log in again", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const response = yield* world.request("http://umail.test/threads", unauthorized());
      expect(response.status).toBe(401);
      expect(yield* readJson(response)).toEqual({
        _tag: "Unauthenticated",
        code: "token_invalid",
        message: "The access token is invalid or expired. Run: umail login",
      });
    }),
  );

  it.effect("lets the exact operator OAuth token reach every retained endpoint group", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const inbound = yield* seedInboundMessage(world, mailbox.id, {
        htmlBody: "<p>sanitized</p>",
        attachments: [
          {
            id: "attachment-1",
            position: 0,
            filename: "attachment.bin",
            mimeType: "application/octet-stream",
            size: 3,
            r2Key: "mail/attachment.bin",
            contentId: null,
            disposition: null,
            isInline: false,
          },
        ],
      });
      world.archive.put("mail/attachment.bin", new Uint8Array([1, 2, 3]));
      const responses = yield* Effect.all(
        [
          world.request("http://umail.test/addresses", authorized(world)),
          world.request("http://umail.test/sending-identities", authorized(world)),
          world.request("http://umail.test/threads", authorized(world)),
          world.request("http://umail.test/messages", authorized(world)),
          world.request("http://umail.test/jobs", authorized(world)),
          world.request(`http://umail.test/messages/${inbound.messageId}`, authorized(world)),
          world.request(
            `http://umail.test/messages/${inbound.messageId}/attachments/attachment-1`,
            authorized(world),
          ),
        ],
        { concurrency: "unbounded" },
      );
      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200, 200, 200, 200, 200,
      ]);
      expect(world.archive.getCalls).toEqual(["mail/attachment.bin"]);
    }),
  );

  it.effect(
    "performs no account, destination, archive, or email side effect for a wrong OAuth bearer",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const mailbox = yield* seedMailbox(world);
        const inbound = yield* seedInboundMessage(world, mailbox.id, {
          attachments: [
            {
              id: "attachment-1",
              position: 0,
              filename: "attachment.bin",
              mimeType: "application/octet-stream",
              size: 3,
              r2Key: "mail/attachment.bin",
              contentId: null,
              disposition: null,
              isInline: false,
            },
          ],
        });
        const writesBefore = world.accountStorage.writeCount;
        const wrong = unauthorized();
        const responses = yield* Effect.all(
          [
            world.request("http://umail.test/addresses", {
              ...wrong,
              method: "POST",
              body: yield* jsonText({ localPart: "blocked" }),
              headers: jsonHeaders(wrong.headers),
            }),
            world.request(`http://umail.test/addresses/${mailbox.id}/forwarding`, {
              ...wrong,
              method: "PUT",
              body: yield* jsonText({ email: "blocked@example.com" }),
              headers: jsonHeaders(wrong.headers),
            }),
            world.request(
              `http://umail.test/messages/${inbound.messageId}/attachments/attachment-1`,
              wrong,
            ),
            world.request("http://umail.test/submissions", {
              ...wrong,
              method: "POST",
              body: yield* jsonText({
                intent: "compose",
                requestId: REQUEST_ID,
                fromAddressId: mailbox.id,
                to: [{ address: "recipient@example.com", displayName: null }],
                subject: "blocked",
                text: "blocked",
              }),
              headers: jsonHeaders(wrong.headers),
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
        expect(world.accountStorage.writeCount).toBe(writesBefore);
        expect(world.destinations.ensureCalls).toEqual([]);
        expect(world.archive.getCalls).toEqual([]);
      }),
  );
});

describe("root mailbox API", () => {
  it.effect("does not retain the old prefixed or browser-only routes", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const current = yield* world.request("http://umail.test/addresses", authorized(world));
      const old = yield* world.request("http://umail.test/api/addresses", authorized(world));
      const html = yield* world.request(
        "http://umail.test/messages/missing/html",
        authorized(world),
      );
      expect(current.status).toBe(200);
      expect(old.status).toBe(404);
      expect(html.status).toBe(404);
    }),
  );

  it.effect("returns thread summaries without bodies and message get with bodies", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const first = yield* seedInboundMessage(world, mailbox.id, {
        id: "message-html",
        htmlBody: '<p>safe</p><img src="/messages/message-html/attachments/attachment-1">',
      });
      const text = yield* seedInboundMessage(world, mailbox.id, {
        id: "message-text",
        htmlBody: null,
        inReplyToHeader: "<message-html@example.com>",
      });
      const response = yield* world.request(
        `http://umail.test/threads/${encodeURIComponent(first.threadId)}`,
        authorized(world),
      );
      expect(response.status).toBe(200);
      const detail = yield* Schema.decodeUnknownEffect(MailThreadDetail)(yield* readJson(response));
      expect(detail.messages.map((message) => message.id)).toEqual([
        first.messageId,
        text.messageId,
      ]);
      expect(yield* jsonText(detail)).not.toContain("textBody");
      expect(yield* jsonText(detail)).not.toContain("htmlBody");
      expect(yield* jsonText(detail)).not.toContain("hasHtmlBody");
      expect(yield* jsonText(detail)).not.toContain("sentBy");
      expect(detail.nextCursor).toBeNull();

      const htmlResponse = yield* world.request(
        `http://umail.test/messages/${first.messageId}`,
        authorized(world),
      );
      expect(htmlResponse.status).toBe(200);
      const htmlMessage = yield* Schema.decodeUnknownEffect(ThreadMessage)(
        yield* readJson(htmlResponse),
      );
      expect(htmlMessage.textBody).toBe("text");
      expect(htmlMessage.htmlBody).toBe(
        '<p>safe</p><img src="/messages/message-html/attachments/attachment-1">',
      );

      const textResponse = yield* world.request(
        `http://umail.test/messages/${text.messageId}`,
        authorized(world),
      );
      expect(textResponse.status).toBe(200);
      const textMessage = yield* Schema.decodeUnknownEffect(ThreadMessage)(
        yield* readJson(textResponse),
      );
      expect(textMessage.textBody).toBe("text");
      expect(textMessage.htmlBody).toBeNull();
    }),
  );

  it.effect("pages getThread with nextCursor when a thread has more than 50 messages", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const first = yield* seedInboundMessage(world, mailbox.id, {
        id: "thread-page-0",
        occurredAt: "2026-01-01T00:00:00.000Z",
      });
      for (let index = 1; index < 51; index += 1) {
        yield* seedInboundMessage(world, mailbox.id, {
          id: `thread-page-${index}`,
          occurredAt: DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"), { seconds: index }),
          ),
          inReplyToHeader: "<thread-page-0@example.com>",
        });
      }
      const threadUrl = `http://umail.test/threads/${encodeURIComponent(first.threadId)}`;
      const response = yield* world.request(threadUrl, authorized(world));
      expect(response.status).toBe(200);
      const detail = yield* Schema.decodeUnknownEffect(MailThreadDetail)(yield* readJson(response));
      expect(detail.threadId).toBe(first.threadId);
      expect(detail.messages).toHaveLength(50);
      expect(detail.messages.map((message) => message.id)).not.toContain("thread-page-50");
      if (detail.nextCursor === null) return yield* Effect.die("expected a second thread page");

      const next = yield* world.request(
        `${threadUrl}?cursor=${encodeURIComponent(detail.nextCursor)}`,
        authorized(world),
      );
      expect(next.status).toBe(200);
      const rest = yield* Schema.decodeUnknownEffect(MailThreadDetail)(yield* readJson(next));
      expect(rest.messages.map((message) => message.id)).toEqual(["thread-page-50"]);
      expect(rest.nextCursor).toBeNull();
    }),
  );

  it.effect("stores sanitized outbound HTML as a durable job without sending", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const response = yield* world.request("http://umail.test/submissions", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText({
          intent: "compose",
          requestId: REQUEST_ID,
          fromAddressId: mailbox.id,
          to: [{ address: "recipient@example.com", displayName: null }],
          subject: "Sanitized",
          html: REMOTE_HTML_SOURCE,
        }),
      });

      expect(response.status, yield* readText(response.clone())).toBe(200);
      const job = yield* Schema.decodeUnknownEffect(OutboundJobStatus)(yield* readJson(response));
      expect(job.state).toBe("ready");
      expect(job.state).not.toBe("accepted");
      const messageResponse = yield* world.request(
        `http://umail.test/messages/${job.messageId}`,
        authorized(world),
      );
      const message = yield* Schema.decodeUnknownEffect(OutboundThreadMessage)(
        yield* readJson(messageResponse),
      );
      expect(message.sendState).toBe("ready");
      expect(message.sendState).not.toBe("accepted");
      expect(message.htmlBody).toBe(REMOTE_HTML_STORED);
      expect(message.hasRemoteImages).toBe(true);
      expect(yield* jsonText(message)).not.toContain("sentBy");
    }),
  );

  it.effect("answers a submission that does not decode with 400 and the offending field", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const submit = (body: string) =>
        Effect.flatMap(
          world.request("http://umail.test/submissions", {
            method: "POST",
            headers: jsonHeaders(authorized(world).headers),
            body,
          }),
          (response) =>
            Effect.map(readJson(response), (json) => ({ status: response.status, json })),
        );
      const valid = {
        intent: "compose",
        requestId: REQUEST_ID,
        fromAddressId: mailbox.id,
        to: [{ address: "recipient@example.com", displayName: null }],
        subject: "Compose job",
        text: "body",
      };
      const invalid = (message: string) => ({
        status: 400,
        json: { _tag: "InvalidRequest", code: "invalid_request", message },
      });

      expect(yield* submit("")).toEqual(
        invalid(
          'Invalid payload: Expected a compose or reply submission (intent: "compose" | "reply")',
        ),
      );
      expect(yield* submit("{not json")).toEqual(
        invalid("Invalid payload: Expected a valid JSON body"),
      );
      expect(
        yield* submit(yield* jsonText({ ...valid, to: [{ address: "Ada <ada@example.com>" }] })),
      ).toEqual(
        invalid(
          "Invalid payload: to.0.address: Expected a bare address like name@example.com, with a lowercase domain and no display name",
        ),
      );
      const { requestId: _, ...withoutRequestId } = valid;
      expect(yield* submit(yield* jsonText(withoutRequestId))).toEqual(
        invalid("Invalid payload: requestId: Expected a requestId (a UUID you generate)"),
      );
      const jobs = yield* world.account.listOutboundJobs({ viewer: { kind: "operator" } });
      expect(jobs.items).toEqual([]);
    }),
  );

  it.effect("answers 500, not 400, when a handler returns a body its schema cannot encode", () =>
    Effect.gen(function* () {
      class Probe extends HttpApiGroup.make("Probe").add(
        HttpApiEndpoint.get("probe", "/probe", { success: Schema.Struct({ n: Schema.Int }) }),
      ) {}
      class ProbeApi extends HttpApi.make("ProbeApi").add(Probe).middleware(RequestErrors) {}
      const handlers = HttpApiBuilder.group(ProbeApi, "Probe", (h) =>
        h.handle("probe", () => Effect.succeed({ n: 1.5 })),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ProbeApi).pipe(
          Layer.provide(handlers),
          Layer.provide([RequestErrorsLive, HttpServer.layerServices]),
        ),
        { disableLogger: true },
      );
      const response = yield* Effect.promise(() => handler(new Request("http://umail.test/probe")));
      yield* Effect.promise(dispose);
      expect(response.status).toBe(500);
    }),
  );

  it.effect("paginates threads without duplicates and rejects malformed cursors", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const seeded = [];
      for (const [id, occurredAt] of [
        ["message-old", "2026-01-01T00:00:00.000Z"],
        ["message-a", "2026-01-02T00:00:00.000Z"],
        ["message-b", "2026-01-02T00:00:00.001Z"],
        ["message-new", "2026-01-03T00:00:00.000Z"],
      ] as const) {
        seeded.push(yield* seedInboundMessage(world, mailbox.id, { id, occurredAt }));
      }

      const firstResponse = yield* world.request(
        "http://umail.test/threads?limit=2",
        authorized(world),
      );
      expect(firstResponse.status).toBe(200);
      const first = yield* Schema.decodeUnknownEffect(MailThreadPage)(
        yield* readJson(firstResponse),
      );
      expect(first.items.map((item) => item.threadId)).toEqual([
        seeded[3]?.threadId,
        seeded[2]?.threadId,
      ]);
      expect(first.nextCursor).not.toBeNull();

      const secondResponse = yield* world.request(
        `http://umail.test/threads?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        authorized(world),
      );
      expect(secondResponse.status).toBe(200);
      const second = yield* Schema.decodeUnknownEffect(MailThreadPage)(
        yield* readJson(secondResponse),
      );
      expect(second.items.map((item) => item.threadId)).toEqual([
        seeded[1]?.threadId,
        seeded[0]?.threadId,
      ]);
      expect(second.nextCursor).toBeNull();
      const allIds = [...first.items, ...second.items].map((item) => item.threadId);
      expect(new Set(allIds).size).toBe(4);

      for (const cursor of [
        "not-base64!",
        Buffer.from("missing separator").toString("base64url"),
        Buffer.from("not-a-date\nthread").toString("base64url"),
      ]) {
        const malformed = yield* world.request(
          `http://umail.test/threads?cursor=${encodeURIComponent(cursor)}`,
          authorized(world),
        );
        expect(malformed.status).toBe(400);
      }
    }),
  );

  it.effect("gets, reads, unreads, and soft-deletes an inbound thread", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const inbound = yield* seedInboundMessage(world, mailbox.id);
      const threadPath = `/threads/${encodeURIComponent(inbound.threadId)}`;

      const initial = yield* world.request(`http://umail.test${threadPath}`, authorized(world));
      expect(initial.status).toBe(200);

      const read = yield* world.request(`http://umail.test${threadPath}/read`, {
        ...authorized(world),
        method: "PATCH",
      });
      expect(read.status).toBe(200);
      const readDetail = yield* Schema.decodeUnknownEffect(MailThreadDetail)(yield* readJson(read));
      expect(readDetail.messages[0]?.direction).toBe("inbound");
      if (readDetail.messages[0]?.direction === "inbound") {
        expect(readDetail.messages[0].isRead).toBe(true);
        expect(readDetail.messages[0].readAt).not.toBeNull();
      }

      const unread = yield* world.request(`http://umail.test${threadPath}/unread`, {
        ...authorized(world),
        method: "PATCH",
      });
      expect(unread.status).toBe(200);
      const unreadDetail = yield* Schema.decodeUnknownEffect(MailThreadDetail)(
        yield* readJson(unread),
      );
      if (unreadDetail.messages[0]?.direction === "inbound") {
        expect(unreadDetail.messages[0].isRead).toBe(false);
      }

      const removed = yield* world.request(`http://umail.test${threadPath}`, {
        ...authorized(world),
        method: "DELETE",
      });
      expect(removed.status).toBe(204);
      expect(
        (yield* world.request(`http://umail.test${threadPath}`, authorized(world))).status,
      ).toBe(404);
    }),
  );

  it.effect("derives reply-all recipients and submits a threaded reply job", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const target = yield* seedInboundMessage(world, mailbox.id, {
        id: "message-parent",
        to: [FROM_ADDRESS, "other@example.com"],
        cc: ["copy@example.com"],
      });

      const replyResponse = yield* world.request("http://umail.test/submissions", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText({
          intent: "reply",
          requestId: REQUEST_ID,
          fromAddressId: mailbox.id,
          subject: "Re: parent",
          text: "reply body",
          replyToMessageId: target.messageId,
          replyMode: "reply-all",
        }),
      });
      expect(replyResponse.status, yield* readText(replyResponse.clone())).toBe(200);
      const job = yield* Schema.decodeUnknownEffect(OutboundJobStatus)(
        yield* readJson(replyResponse),
      );
      expect(job.state).toBe("ready");
      const thread = yield* Schema.decodeUnknownEffect(MailThreadDetail)(
        yield* readJson(
          yield* world.request(
            `http://umail.test/threads/${encodeURIComponent(target.threadId)}`,
            authorized(world),
          ),
        ),
      );
      expect(thread.messages.map((message) => message.id)).toContain(job.messageId);
      const reply = yield* Schema.decodeUnknownEffect(OutboundThreadMessage)(
        yield* readJson(
          yield* world.request(`http://umail.test/messages/${job.messageId}`, authorized(world)),
        ),
      );
      expect(reply.to.map((contact) => contact.address)).toEqual(["sender@example.com"]);
      expect(reply.cc.map((contact) => contact.address)).toEqual([
        "other@example.com",
        "copy@example.com",
      ]);
    }),
  );

  it.effect("threads a reply to our own accepted outbound message onto that message", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const sendResponse = yield* world.request("http://umail.test/submissions", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText({
          intent: "compose",
          requestId: REQUEST_ID,
          fromAddressId: mailbox.id,
          to: [{ address: "recipient@example.com", displayName: null }],
          subject: "Hello",
          text: "outbound body",
        }),
      });
      expect(sendResponse.status, yield* readText(sendResponse.clone())).toBe(200);
      const sent = yield* Schema.decodeUnknownEffect(OutboundJobStatus)(
        yield* readJson(sendResponse),
      );

      yield* runDueWorkPass(world, {
        outcome: { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: PROVIDER_RFC_ID },
      });
      expect(yield* world.account.getOutboundJob(sent.jobId, { kind: "operator" })).toMatchObject({
        state: "accepted",
      });

      const replyResponse = yield* world.request("http://umail.test/submissions", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText({
          intent: "reply",
          requestId: REPLY_REQUEST_ID,
          fromAddressId: mailbox.id,
          subject: "Re: Hello",
          text: "reply body",
          replyToMessageId: sent.messageId,
          replyMode: "reply",
        }),
      });
      expect(replyResponse.status, yield* readText(replyResponse.clone())).toBe(200);
      const replyJob = yield* Schema.decodeUnknownEffect(OutboundJobStatus)(
        yield* readJson(replyResponse),
      );
      const reply = yield* Schema.decodeUnknownEffect(OutboundThreadMessage)(
        yield* readJson(
          yield* world.request(
            `http://umail.test/messages/${replyJob.messageId}`,
            authorized(world),
          ),
        ),
      );
      expect(reply.inReplyToRfcMessageId).toBe(PROVIDER_RFC_ID);
      expect(reply.parentMessageId).toBe(sent.messageId);
    }),
  );

  it.effect("returns reply errors without creating a job", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const missing = yield* world.request("http://umail.test/submissions", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText({
          intent: "reply",
          requestId: REQUEST_ID,
          fromAddressId: mailbox.id,
          subject: "Re: missing",
          text: "reply body",
          replyToMessageId: "missing",
          replyMode: "reply",
        }),
      });
      expect(missing.status).toBe(404);
      const jobs = yield* world.account.listOutboundJobs({ viewer: { kind: "operator" } });
      expect(jobs.items).toEqual([]);
    }),
  );

  it.effect("forwards an address to any email and reports Cloudflare's live verification", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const forward = Effect.fn("forward")(function* (email: string) {
        return yield* world.request(`http://umail.test/addresses/${mailbox.id}/forwarding`, {
          method: "PUT",
          headers: jsonHeaders(authorized(world).headers),
          body: yield* jsonText({ email }),
        });
      });

      const pending = yield* forward("owner@example.com");
      expect(pending.status, yield* readText(pending.clone())).toBe(200);
      expect(
        yield* Schema.decodeUnknownEffect(AddressForwarding)(yield* readJson(pending)),
      ).toMatchObject({
        address: { id: mailbox.id, forwardTo: "owner@example.com" },
        verified: false,
      });
      world.destinations.verify("owner@example.com");
      const verified = yield* Schema.decodeUnknownEffect(AddressForwarding)(
        yield* readJson(yield* forward("owner@example.com")),
      );
      expect(verified.verified).toBe(true);
      expect(world.destinations.ensureCalls).toEqual(["owner@example.com", "owner@example.com"]);

      world.destinations.failNext(
        new InvalidRequest({
          code: "forwarding_rejected",
          message: "This email address is not allowed.",
        }),
      );
      const refused = yield* forward("blocked@example.com");
      expect(refused.status).toBe(400);
      expect(yield* readJson(refused)).toMatchObject({
        message: "This email address is not allowed.",
      });
      expect((yield* world.account.getAddress(mailbox.id))?.forwardTo).toBe("owner@example.com");
    }),
  );

  it.effect("answers an unknown address and clears forwarding without calling Cloudflare", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      yield* world.account.setAddressForwarding(
        mailbox.id,
        "owner@example.com",
        "2026-01-01T00:00:00.000Z",
      );

      const unknown = yield* world.request("http://umail.test/addresses/missing/forwarding", {
        method: "PUT",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText({ email: "owner@example.com" }),
      });
      expect(unknown.status).toBe(404);
      const removed = yield* world.request(`http://umail.test/addresses/${mailbox.id}/forwarding`, {
        method: "DELETE",
        ...authorized(world),
      });
      expect(removed.status).toBe(200);
      expect(yield* readJson(removed)).toMatchObject({ id: mailbox.id, forwardTo: null });
      expect(world.destinations.ensureCalls).toEqual([]);
    }),
  );

  it.effect(
    "serves exact attachment bytes and does not map archive transport failure to NotFound",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const mailbox = yield* seedMailbox(world);
        const inbound = yield* seedInboundMessage(world, mailbox.id, {
          attachments: [
            {
              id: "attachment-1",
              position: 0,
              filename: "attachment.bin",
              mimeType: "application/octet-stream",
              size: 3,
              r2Key: "mail/attachment.bin",
              contentId: null,
              disposition: null,
              isInline: false,
            },
          ],
        });

        const absentRow = yield* world.request(
          `http://umail.test/messages/${inbound.messageId}/attachments/missing`,
          authorized(world),
        );
        expect(absentRow.status).toBe(404);
        expect(world.archive.getCalls).toEqual([]);

        const absentObject = yield* world.request(
          `http://umail.test/messages/${inbound.messageId}/attachments/attachment-1`,
          authorized(world),
        );
        expect(absentObject.status).toBe(404);
        expect(world.archive.getCalls).toEqual(["mail/attachment.bin"]);

        world.archive.failNextTransport();
        const transport = yield* world.request(
          `http://umail.test/messages/${inbound.messageId}/attachments/attachment-1`,
          authorized(world),
        );
        expect(transport.status).toBe(502);
        expect(transport.status).not.toBe(404);

        world.archive.put("mail/attachment.bin", new Uint8Array([0, 1, 2, 255]));
        const found = yield* world.request(
          `http://umail.test/messages/${inbound.messageId}/attachments/attachment-1`,
          authorized(world),
        );
        expect(found.status).toBe(200);
        expect(new Uint8Array(yield* Effect.promise(() => found.arrayBuffer()))).toEqual(
          new Uint8Array([0, 1, 2, 255]),
        );
        expect(found.headers.get("content-type")).toBe("application/octet-stream");
        expect(found.headers.get("content-disposition")).toContain("attachment.bin");
        expect(found.headers.get("x-content-type-options")).toBe("nosniff");
      }),
  );

  it.effect("serves exact archived source bytes as a download and maps archive faults to 502", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const inbound = yield* seedInboundMessage(world, mailbox.id, { id: "source-in" });
      const source = new Uint8Array([
        ...new TextEncoder().encode("Subject: raw\r\n\r\n"),
        0x00,
        0xff,
        0xfe,
        0x80,
        0x0a,
      ]);
      const sourcePath = `http://umail.test/messages/${inbound.messageId}/source`;

      const absentObject = yield* world.request(sourcePath, authorized(world));
      expect(absentObject.status).toBe(404);
      expect(world.archive.getCalls).toEqual(["raw/source-in"]);

      world.archive.put("raw/source-in", source);
      world.archive.failNextTransport();
      const transport = yield* world.request(sourcePath, authorized(world));
      expect(transport.status).toBe(502);
      expect(transport.status).not.toBe(404);

      const found = yield* world.request(sourcePath, authorized(world));
      expect(found.status).toBe(200);
      expect(new Uint8Array(yield* Effect.promise(() => found.arrayBuffer()))).toEqual(source);
      expect(found.headers.get("content-type")).toBe("message/rfc822");
      expect(found.headers.get("content-disposition")).toBe(
        `attachment; filename="source-in.eml"; filename*=UTF-8''source-in.eml`,
      );
      expect(found.headers.get("x-content-type-options")).toBe("nosniff");
    }),
  );

  it.effect("answers 409 for outbound and 404 for unknown or soft-deleted message source", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const inbound = yield* seedInboundMessage(world, mailbox.id, { id: "deleted-in" });
      world.archive.put("raw/deleted-in", new Uint8Array([1, 2, 3]));
      const sendResponse = yield* world.request("http://umail.test/submissions", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText({
          intent: "compose",
          requestId: REQUEST_ID,
          fromAddressId: mailbox.id,
          to: [{ address: "recipient@example.com", displayName: null }],
          subject: "Outbound",
          text: "outbound body",
        }),
      });
      expect(sendResponse.status).toBe(200);
      const job = yield* Schema.decodeUnknownEffect(OutboundJobStatus)(
        yield* readJson(sendResponse),
      );

      const outbound = yield* world.request(
        `http://umail.test/messages/${job.messageId}/source`,
        authorized(world),
      );
      expect(outbound.status).toBe(409);
      expect(yield* readJson(outbound)).toMatchObject({
        _tag: "Conflict",
        code: "no_archived_source",
      });

      const unknown = yield* world.request(
        "http://umail.test/messages/unknown/source",
        authorized(world),
      );
      expect(unknown.status).toBe(404);

      const removed = yield* world.request(
        `http://umail.test/threads/${encodeURIComponent(inbound.threadId)}`,
        { ...authorized(world), method: "DELETE" },
      );
      expect(removed.status).toBe(204);
      const deleted = yield* world.request(
        `http://umail.test/messages/${inbound.messageId}/source`,
        authorized(world),
      );
      expect(deleted.status).toBe(404);
      expect(world.archive.getCalls).toEqual([]);
    }),
  );

  it.effect("reads no archived source before the principal is authorized and in scope", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      const probe = yield* seedMailbox(world, "probe");
      const inbound = yield* seedInboundMessage(world, inbox.id, { id: "scoped-in" });
      world.archive.put("raw/scoped-in", new Uint8Array([1, 2, 3]));

      const wrongBearer = yield* world.request(
        `http://umail.test/messages/${inbound.messageId}/source`,
        unauthorized(),
      );
      expect(wrongBearer.status).toBe(401);

      const outOfScope = mcpPrincipal(world, "out-of-scope-reader", {
        mailboxIds: [probe.id],
        canRead: true,
      });
      expect(
        yield* Effect.flip(world.run(readMessageSource(world.deps, outOfScope, inbound.messageId))),
      ).toMatchObject({ _tag: "NotFound" });

      const cannotRead = mcpPrincipal(world, "no-read-client", {
        mailboxIds: "all",
        canRead: false,
      });
      expect(
        yield* Effect.flip(world.run(readMessageSource(world.deps, cannotRead, inbound.messageId))),
      ).toMatchObject({ _tag: "NotPermitted", code: "read_denied" });

      expect(world.archive.getCalls).toEqual([]);
    }),
  );

  it.effect("lists last-24h inbound, address, unread, and pages by cursor", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      const probe = yield* seedMailbox(world, "probe");
      yield* seedInboundMessage(world, inbox.id, {
        id: "old-in",
        occurredAt: "2026-08-24T10:00:00.000Z",
      });
      const recent = yield* seedInboundMessage(world, inbox.id, {
        id: "recent-in",
        occurredAt: "2026-08-25T18:00:00.000Z",
      });
      yield* seedInboundMessage(world, probe.id, {
        id: "probe-in",
        occurredAt: "2026-08-25T19:00:00.000Z",
      });
      const sendResponse = yield* world.request("http://umail.test/submissions", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText({
          intent: "compose",
          requestId: REQUEST_ID,
          fromAddressId: inbox.id,
          to: [{ address: "recipient@example.com", displayName: null }],
          subject: "Outbound",
          text: "outbound body",
        }),
      });
      expect(sendResponse.status, yield* readText(sendResponse.clone())).toBe(200);

      const since = "2026-08-25T00:00:00.000Z";
      const inboundResponse = yield* world.request(
        `http://umail.test/messages?direction=inbound&since=${encodeURIComponent(since)}`,
        authorized(world),
      );
      expect(inboundResponse.status).toBe(200);
      const inbound = yield* Schema.decodeUnknownEffect(MailMessagePage)(
        yield* readJson(inboundResponse),
      );
      expect(inbound.items.map((item) => item.id)).toEqual(["probe-in", recent.messageId]);
      expect(yield* jsonText(inbound)).not.toContain("textBody");
      expect(yield* jsonText(inbound)).not.toContain("htmlBody");
      expect(yield* jsonText(inbound)).not.toContain("outbound body");

      const addressResponse = yield* world.request(
        `http://umail.test/messages?addressId=${encodeURIComponent(inbox.id)}`,
        authorized(world),
      );
      expect(addressResponse.status).toBe(200);
      const byAddress = yield* Schema.decodeUnknownEffect(MailMessagePage)(
        yield* readJson(addressResponse),
      );
      expect(byAddress.items.every((item) => item.addressId === inbox.id)).toBe(true);
      expect(byAddress.items.map((item) => item.id)).not.toContain("probe-in");

      yield* world.account.markThreadRead(recent.threadId, true, "all", "2026-08-25T18:01:00.000Z");
      const unreadResponse = yield* world.request(
        "http://umail.test/messages?unread=true",
        authorized(world),
      );
      expect(unreadResponse.status).toBe(200);
      const unread = yield* Schema.decodeUnknownEffect(MailMessagePage)(
        yield* readJson(unreadResponse),
      );
      expect(unread.items.map((item) => item.id)).toEqual(["probe-in", "old-in"]);
      expect(unread.items.every((item) => item.direction === "inbound")).toBe(true);

      const firstResponse = yield* world.request(
        "http://umail.test/messages?limit=2",
        authorized(world),
      );
      expect(firstResponse.status).toBe(200);
      const first = yield* Schema.decodeUnknownEffect(MailMessagePage)(
        yield* readJson(firstResponse),
      );
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const secondResponse = yield* world.request(
        `http://umail.test/messages?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        authorized(world),
      );
      expect(secondResponse.status).toBe(200);
      const second = yield* Schema.decodeUnknownEffect(MailMessagePage)(
        yield* readJson(secondResponse),
      );
      const pagedIds = [...first.items, ...second.items].map((item) => item.id);
      expect(new Set(pagedIds).size).toBe(pagedIds.length);
      expect(pagedIds).toEqual(expect.arrayContaining(["probe-in", recent.messageId, "old-in"]));

      for (const cursor of [
        "not-base64!",
        Buffer.from("missing separator").toString("base64url"),
        Buffer.from("not-a-date\nmessage").toString("base64url"),
      ]) {
        const malformed = yield* world.request(
          `http://umail.test/messages?cursor=${encodeURIComponent(cursor)}`,
          authorized(world),
        );
        expect(malformed.status).toBe(400);
      }
    }),
  );

  it.effect("replays an identical submission key and conflicts on a changed payload", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const mailbox = yield* seedMailbox(world);
      const body = {
        intent: "compose",
        requestId: REQUEST_ID,
        fromAddressId: mailbox.id,
        to: [{ address: "recipient@example.com", displayName: null }],
        subject: "Hello",
        text: "body",
      };
      const first = yield* world.request("http://umail.test/submissions", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText(body),
      });
      const replay = yield* world.request("http://umail.test/submissions", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText(body),
      });
      const conflict = yield* world.request("http://umail.test/submissions", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText({ ...body, subject: "Changed" }),
      });
      const firstJob = yield* Schema.decodeUnknownEffect(OutboundJobStatus)(yield* readJson(first));
      const replayJob = yield* Schema.decodeUnknownEffect(OutboundJobStatus)(
        yield* readJson(replay),
      );
      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replayJob.jobId).toBe(firstJob.jobId);
      expect(conflict.status).toBe(409);
      const listed = yield* world.request("http://umail.test/jobs", authorized(world));
      const page = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ items: Schema.Array(OutboundJobStatus) }),
      )(yield* readJson(listed));
      expect(page.items.map((item) => item.jobId)).toEqual([firstJob.jobId]);
    }),
  );

  it.effect(
    "rejects a submission with more than 50 To and CC recipients without creating a job",
    () =>
      Effect.gen(function* () {
        const world = yield* createWorld();
        const mailbox = yield* seedMailbox(world);
        const recipients = Array.from({ length: 51 }, (_, index) => ({
          address: `recipient-${String(index)}@example.com`,
          displayName: null,
        }));
        const response = yield* world.request("http://umail.test/submissions", {
          method: "POST",
          headers: jsonHeaders(authorized(world).headers),
          body: yield* jsonText({
            intent: "compose",
            requestId: REQUEST_ID,
            fromAddressId: mailbox.id,
            to: recipients.slice(0, 40),
            cc: recipients.slice(40),
            subject: "Too many",
            text: "body",
          }),
        });

        expect(response.status).toBe(400);
        expect(yield* readJson(response)).toEqual({
          _tag: "InvalidRequest",
          code: "too_many_recipients",
          message: "A message may have at most 50 To and CC recipients.",
        });
        const jobs = yield* world.account.listOutboundJobs({ viewer: { kind: "operator" } });
        expect(jobs.items).toEqual([]);
      }),
  );
});

const OK_RECIPIENT = Schema.decodeSync(ExternalMailAddress)("ok@example.com");

describe("error reasons", () => {
  // The status and body a caller reads for one request.
  const answer = Effect.fn("answer")(function* (world: World, path: string, init?: RequestInit) {
    const response = yield* world.request(`http://umail.test${path}`, {
      ...authorized(world),
      ...init,
      headers: jsonHeaders(authorized(world).headers),
    });
    return { status: response.status, body: yield* readJson(response) };
  });
  const post = (world: World, path: string, body: unknown) =>
    Effect.flatMap(jsonText(body), (text) => answer(world, path, { method: "POST", body: text }));
  // The error's fields, as they would be encoded.
  const failure = <A, E extends ApiError>(
    world: World,
    effect: Effect.Effect<A, E, Crypto.Crypto | Alchemy.RuntimeContext>,
  ) =>
    Effect.map(Effect.flip(world.run(effect)), (error) => ({
      _tag: error._tag,
      code: error.code,
      message: error.message,
    }));
  const compose = (fromAddressId: string, to: ReadonlyArray<string>, extra = {}) =>
    Schema.decodeUnknownEffect(SubmitMessagePayload)({
      intent: "compose",
      requestId: REQUEST_ID,
      fromAddressId,
      to: to.map((address) => ({ address })),
      subject: "Hello",
      text: "body",
      ...extra,
    }).pipe(Effect.orDie);
  const sender = (world: World, policy: Partial<PrincipalPolicy>): McpPrincipal => ({
    authority: "mcp",
    identity: { userId: world.operatorId, clientId: "agent", clientLabel: "agent" },
    policy: {
      mailboxIds: "all",
      canRead: true,
      sendMode: { kind: "allow" },
      recipientAllowlist: "any",
      ...policy,
    },
  });

  it.effect("names the policy that refused a send, and only the caller's own inputs", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      const probe = yield* seedMailbox(world, "probe");
      const allowlisted = sender(world, {
        recipientAllowlist: [OK_RECIPIENT],
      });

      expect(
        yield* failure(
          world,
          submitMessage(
            world.deps,
            allowlisted,
            yield* compose(inbox.id, ["ok@example.com", "a@example.com"], {
              cc: [{ address: "b@example.com" }],
            }),
          ),
        ),
      ).toEqual({
        _tag: "NotPermitted",
        code: "recipient_not_allowed",
        message:
          "Recipients not allowed for this client: a@example.com, b@example.com. Remove them, or ask the operator to allow them.",
      });
      expect(
        yield* failure(
          world,
          submitMessage(
            world.deps,
            sender(world, { mailboxIds: [probe.id] }),
            yield* compose(inbox.id, ["a@example.com"]),
          ),
        ),
      ).toEqual({
        _tag: "NotPermitted",
        code: "mailbox_forbidden",
        message: `This client may not send from mailbox ${inbox.id}. Use a sending identity it is allowed to use.`,
      });
      expect(
        yield* failure(
          world,
          submitMessage(
            world.deps,
            sender(world, { sendMode: { kind: "deny" } }),
            yield* compose(inbox.id, ["a@example.com"]),
          ),
        ),
      ).toEqual({
        _tag: "NotPermitted",
        code: "send_denied",
        message: "This client may not send mail.",
      });
      expect(
        yield* failure(
          world,
          listThreads(world.deps, sender(world, { canRead: false }), undefined, undefined),
        ),
      ).toEqual({
        _tag: "NotPermitted",
        code: "read_denied",
        message: "This client has no read access.",
      });

      // A mailbox outside the client's scope reads exactly like one that does not exist.
      const scoped = sender(world, { mailboxIds: [inbox.id] });
      const outOfScope = yield* failure(
        world,
        listMessages(world.deps, scoped, { addressId: probe.id }),
      );
      expect(outOfScope).toEqual({
        _tag: "NotFound",
        code: "mailbox_not_found",
        message: `Mailbox ${probe.id} was not found, or it is outside this client's access.`,
      });
      expect(
        yield* failure(world, listMessages(world.deps, scoped, { addressId: "nope" })),
      ).toEqual({ ...outOfScope, message: outOfScope.message.replace(probe.id, "nope") });
      expect(
        yield* Effect.map(
          world.run(listMessages(world.deps, scoped, { addressId: inbox.id })),
          (page) => page.items,
        ),
      ).toEqual([]);
      const jobs = yield* world.account.listOutboundJobs({ viewer: { kind: "operator" } });
      expect(jobs.items).toEqual([]);
    }),
  );

  it.effect("names the missing id and says it may be outside the client's access", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const notFound = (code: string, subject: string) => ({
        status: 404,
        body: {
          _tag: "NotFound",
          code,
          message: `${subject} was not found, or it is outside this client's access.`,
        },
      });
      expect(yield* answer(world, "/threads/t-missing")).toEqual(
        notFound("thread_not_found", "Thread t-missing"),
      );
      expect(yield* answer(world, "/messages/m-missing")).toEqual(
        notFound("message_not_found", "Message m-missing"),
      );
      expect(yield* answer(world, "/jobs/j-missing")).toEqual(
        notFound("job_not_found", "Job j-missing"),
      );
    }),
  );

  it.effect("explains a refused mailbox name and a duplicate", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      expect(yield* post(world, "/addresses", { localPart: "postmaster" })).toEqual({
        status: 400,
        body: {
          _tag: "InvalidRequest",
          code: "address_reserved",
          message: '"postmaster" is reserved for mail-system use. Choose another name.',
        },
      });
      expect(yield* post(world, "/addresses", { localPart: "no spaces" })).toEqual({
        status: 400,
        body: {
          _tag: "InvalidRequest",
          code: "address_invalid",
          message:
            "\"no spaces\" is not a valid mailbox name. Use only letters, digits, '.', '_' and '-'.",
        },
      });
      expect((yield* post(world, "/addresses", { localPart: "support" })).status).toBe(200);
      expect(yield* post(world, "/addresses", { localPart: "support" })).toEqual({
        status: 409,
        body: {
          _tag: "Conflict",
          code: "address_exists",
          message: "support@umail.example.com already exists.",
        },
      });
    }),
  );

  it.effect("explains a reused requestId, a bad cursor, an HTML limit and an inactive sender", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world);
      const submission = {
        intent: "compose",
        requestId: REQUEST_ID,
        fromAddressId: inbox.id,
        to: [{ address: "a@example.com" }],
        subject: "Hello",
        text: "body",
      };
      expect((yield* post(world, "/submissions", submission)).status).toBe(200);
      expect(yield* post(world, "/submissions", { ...submission, subject: "Changed" })).toEqual({
        status: 409,
        body: {
          _tag: "Conflict",
          code: "request_id_reused",
          message: `requestId ${REQUEST_ID} was already used for different content. Resubmitting the same content returns the existing job; use a new requestId for a new message.`,
        },
      });

      expect(yield* answer(world, "/threads?cursor=not-a-cursor")).toEqual({
        status: 400,
        body: {
          _tag: "InvalidRequest",
          code: "invalid_cursor",
          message:
            "The cursor is not valid. Pass nextCursor from the previous page unchanged, or omit it.",
        },
      });

      world.htmlPolicy.failSanitization("open_elements");
      expect(
        yield* post(world, "/submissions", {
          ...submission,
          requestId: REPLY_REQUEST_ID,
          html: "<div>deep</div>",
        }),
      ).toEqual({
        status: 400,
        body: {
          _tag: "InvalidRequest",
          code: "html_too_complex",
          message:
            "The HTML body exceeds the 128-level nesting limit. Simplify it or send text only.",
        },
      });

      yield* world.account.patchAddress(inbox.id, { active: false }, "2026-01-02T00:00:00.000Z");
      expect(
        yield* post(world, "/submissions", { ...submission, requestId: REPLY_REQUEST_ID }),
      ).toEqual({
        status: 400,
        body: {
          _tag: "InvalidRequest",
          code: "from_address_inactive",
          message: `Mailbox ${inbox.id} (inbox@umail.example.com) is inactive. Reactivate it, or send from an active id in the sending-identities list.`,
        },
      });
      expect(
        yield* post(world, "/submissions", {
          ...submission,
          requestId: REPLY_REQUEST_ID,
          fromAddressId: "nope",
        }),
      ).toMatchObject({ status: 400, body: { code: "from_address_unknown" } });
    }),
  );
});

describe("store failures and query input at the HTTP edge", () => {
  it.effect("answers 409 when creating an address fails with a plain conflict envelope", () =>
    Effect.gen(function* () {
      const world = yield* createWorld({
        account: {
          createAddress: () =>
            failOverRpc({ _tag: "AccountConflictError", address: "inbox@umail.example.com" }),
        },
      });
      const response = yield* world.request("http://umail.test/addresses", {
        method: "POST",
        headers: jsonHeaders(authorized(world).headers),
        body: yield* jsonText({ localPart: "inbox" }),
      });
      expect(response.status).toBe(409);
    }),
  );

  it.effect("answers 500, not 400, when the store call fails with an RpcCallError", () =>
    Effect.gen(function* () {
      const world = yield* createWorld({
        account: {
          listAddresses: () =>
            failOverRpc(
              new RpcCallError({ method: "listAddresses", cause: new Error("DO reset") }),
            ),
        },
      });
      const response = yield* world.request("http://umail.test/addresses", authorized(world));
      expect(response.status).toBe(500);
    }),
  );

  it.effect(
    "normalizes an offset since before the store call and rejects malformed ones with 400",
    () =>
      Effect.gen(function* () {
        const queries: Array<ListMessageSummariesQuery> = [];
        const world = yield* createWorld({
          account: {
            listMessageSummaries: (query) => {
              queries.push(query);
              return Effect.succeed({ items: [], nextCursor: null });
            },
          },
        });
        const offset = yield* world.request(
          `http://umail.test/messages?since=${encodeURIComponent("2026-08-25T02:00:00+02:00")}`,
          authorized(world),
        );
        expect(offset.status).toBe(200);
        expect(queries.map((query) => query.since)).toEqual(["2026-08-25T00:00:00.000Z"]);

        for (const since of ["not-a-date", "+275760-09-13T00:00:00.000Z"]) {
          const malformed = yield* world.request(
            `http://umail.test/messages?since=${encodeURIComponent(since)}`,
            authorized(world),
          );
          expect(malformed.status).toBe(400);
        }
        expect(queries).toHaveLength(1);
      }),
  );

  it.effect("answers 400 for a list cursor whose timestamp is out of range", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const cursor = Buffer.from("+010000-01-01T00:00:00.000Z\nx").toString("base64url");
      for (const path of ["/jobs", "/threads", "/messages"]) {
        const response = yield* world.request(
          `http://umail.test${path}?cursor=${encodeURIComponent(cursor)}`,
          authorized(world),
        );
        expect(response.status, path).toBe(400);
      }
    }),
  );
});

// Expected DO failures reach the Api as plain `{ _tag, ... }` objects, never class instances.
function failOverRpc(error: unknown): Effect.Effect<never, AccountStoreError> {
  return Effect.fail(error as AccountStoreError);
}

type McpReadAccess = Pick<PrincipalPolicy, "mailboxIds" | "canRead">;

function mcpPrincipal(world: World, clientId: string, access: McpReadAccess): McpPrincipal {
  return {
    authority: "mcp",
    identity: { userId: world.operatorId, clientId, clientLabel: clientId },
    policy: { ...access, sendMode: { kind: "deny" }, recipientAllowlist: "any" },
  };
}
