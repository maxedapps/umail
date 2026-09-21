import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { describe, expect, it } from "vitest";

import {
  ForwardingDestination,
  MailMessagePage,
  McpClient,
  NormalizedRfcMessageId,
  type McpPrincipal,
  type PrincipalPolicy,
  MailThreadDetail,
  MailThreadMessagePage,
  MailThreadPage,
  OutboundJobStatus,
  OutboundThreadMessage,
  ReplyPlan,
  SubmissionRequestId,
  ThreadMessage,
  UmailApi,
} from "@umail/api-contract";
import { attachmentHeaders, attachmentResponseHeaders } from "../../src/api/attachments.ts";
import { readMessageSource } from "../../src/api/operations.ts";
import { REMOTE_HTML_SOURCE, REMOTE_HTML_STORED } from "./fakes.ts";
import {
  FROM_ADDRESS,
  OPERATOR_PASSWORD,
  authorized,
  createWorld,
  jsonHeaders,
  seedInboundMessage,
  seedMailbox,
  unauthorized,
  type World,
} from "./world.ts";

const REQUEST_ID = Schema.decodeSync(SubmissionRequestId)("11111111-1111-4111-8111-111111111111");
const REPLY_REQUEST_ID = Schema.decodeSync(SubmissionRequestId)(
  "22222222-2222-4222-8222-222222222222",
);
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
    expect(paths).toContain("/forwarding-destinations");
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
  it("returns the same envelope, parsed date, and forwarding observation on every REST read", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const inbound = await seedInboundMessage(world, mailbox.id, {
      id: "authoritative-inbound",
      from: "header-sender@example.com",
      to: ["visible-recipient@example.com"],
      envelopeFrom: "",
      envelopeTo: FROM_ADDRESS,
      parsedDate: "2026-08-25T10:00:00.000Z",
      occurredAt: "2026-08-25T11:00:00.000Z",
      forward: {
        kind: "failure",
        destination: "forward@example.net",
        error: "provider rejected",
      },
    });

    const list = await Schema.decodeUnknownPromise(MailMessagePage)(
      await (await world.fetch("http://umail.test/messages", authorized(world))).json(),
    );
    const message = await Schema.decodeUnknownPromise(ThreadMessage)(
      await (
        await world.fetch(`http://umail.test/messages/${inbound.messageId}`, authorized(world))
      ).json(),
    );
    const threadMessages = await Schema.decodeUnknownPromise(MailThreadMessagePage)(
      await (
        await world.fetch(
          `http://umail.test/threads/${encodeURIComponent(inbound.threadHandle)}/messages`,
          authorized(world),
        )
      ).json(),
    );
    const thread = await Schema.decodeUnknownPromise(MailThreadDetail)(
      await (
        await world.fetch(
          `http://umail.test/threads/${encodeURIComponent(inbound.threadHandle)}`,
          authorized(world),
        )
      ).json(),
    );

    const summaries = [list.items[0], message, threadMessages.items[0], thread.messages[0]];
    for (const summary of summaries) {
      expect(summary?.direction).toBe("inbound");
      if (summary?.direction === "inbound") {
        expect(summary).toMatchObject({
          envelopeFrom: "",
          envelopeTo: FROM_ADDRESS,
          parsedDate: "2026-08-25T10:00:00.000Z",
          occurredAt: "2026-08-25T11:00:00.000Z",
          processingState: "indexed",
          processingError: null,
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
  });
});

describe("root authorization boundary", () => {
  it.each([
    ["absent", undefined],
    ["wrong scheme", "Basic YWJjOmRlZg=="],
    ["empty", "Bearer "],
    ["garbage", "Bearer not-a-valid-credential"],
  ])("rejects %s credentials without exposing the access token", async (_name, authorization) => {
    const world = await createWorld();
    const headers = new Headers();
    if (authorization !== undefined) headers.set("authorization", authorization);
    const response = await world.fetch("http://umail.test/threads", { headers });
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain(world.operatorAccessToken);
    expect(body).not.toContain(OPERATOR_PASSWORD);
  });

  it("lets the exact operator OAuth token reach every retained endpoint group", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const inbound = await seedInboundMessage(world, mailbox.id, {
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
    const responses = await Promise.all([
      world.fetch("http://umail.test/addresses", authorized(world)),
      world.fetch("http://umail.test/sending-identities", authorized(world)),
      world.fetch("http://umail.test/forwarding-destinations", authorized(world)),
      world.fetch("http://umail.test/threads", authorized(world)),
      world.fetch("http://umail.test/messages", authorized(world)),
      world.fetch("http://umail.test/jobs", authorized(world)),
      world.fetch(`http://umail.test/messages/${inbound.messageId}`, authorized(world)),
      world.fetch(
        `http://umail.test/messages/${inbound.messageId}/reply-plan?mode=reply`,
        authorized(world),
      ),
      world.fetch(
        `http://umail.test/messages/${inbound.messageId}/attachments/attachment-1`,
        authorized(world),
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 200,
    ]);
    expect(world.archive.getCalls).toEqual(["mail/attachment.bin"]);
  });

  it("performs no account, destination, archive, or email side effect for a wrong OAuth bearer", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const inbound = await seedInboundMessage(world, mailbox.id, {
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
    const responses = await Promise.all([
      world.fetch("http://umail.test/addresses", {
        ...wrong,
        method: "POST",
        body: JSON.stringify({ localPart: "blocked" }),
        headers: jsonHeaders(wrong.headers),
      }),
      world.fetch("http://umail.test/forwarding-destinations", {
        ...wrong,
        method: "POST",
        body: JSON.stringify({ email: "blocked@example.com" }),
        headers: jsonHeaders(wrong.headers),
      }),
      world.fetch(
        `http://umail.test/messages/${inbound.messageId}/attachments/attachment-1`,
        wrong,
      ),
      world.fetch("http://umail.test/submissions", {
        ...wrong,
        method: "POST",
        body: JSON.stringify({
          intent: "compose",
          requestId: REQUEST_ID,
          fromAddressId: mailbox.id,
          to: [{ address: "recipient@example.com", displayName: null }],
          subject: "blocked",
          text: "blocked",
        }),
        headers: jsonHeaders(wrong.headers),
      }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    expect(world.accountStorage.writeCount).toBe(writesBefore);
    expect(world.destinations.items.size).toBe(0);
    expect(world.destinations.createCalls).toEqual([]);
    expect(world.destinations.getCalls).toEqual([]);
    expect(world.destinations.deleteCalls).toEqual([]);
    expect(world.archive.getCalls).toEqual([]);
  });
});

describe("root mailbox API", () => {
  it("does not retain the old prefixed or browser-only routes", async () => {
    const world = await createWorld();
    const current = await world.fetch("http://umail.test/addresses", authorized(world));
    const old = await world.fetch("http://umail.test/api/addresses", authorized(world));
    const html = await world.fetch("http://umail.test/messages/missing/html", authorized(world));
    expect(current.status).toBe(200);
    expect(old.status).toBe(404);
    expect(html.status).toBe(404);
  });

  it("returns thread summaries without bodies and message get with bodies", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const first = await seedInboundMessage(world, mailbox.id, {
      id: "message-html",
      htmlBody: '<p>safe</p><img src="/messages/message-html/attachments/attachment-1">',
    });
    const text = await seedInboundMessage(world, mailbox.id, {
      id: "message-text",
      htmlBody: null,
      inReplyToHeader: "<message-html@example.com>",
    });
    const response = await world.fetch(
      `http://umail.test/threads/${encodeURIComponent(first.threadHandle)}`,
      authorized(world),
    );
    expect(response.status).toBe(200);
    const detail = await Schema.decodeUnknownPromise(MailThreadDetail)(await response.json());
    expect(detail.messages.map((message) => message.id)).toEqual([first.messageId, text.messageId]);
    expect(JSON.stringify(detail)).not.toContain("textBody");
    expect(JSON.stringify(detail)).not.toContain("htmlBody");
    expect(JSON.stringify(detail)).not.toContain("hasHtmlBody");
    expect(JSON.stringify(detail)).not.toContain("sentBy");
    expect(detail.nextCursor).toBeNull();

    const htmlResponse = await world.fetch(
      `http://umail.test/messages/${first.messageId}`,
      authorized(world),
    );
    expect(htmlResponse.status).toBe(200);
    const htmlMessage = await Schema.decodeUnknownPromise(ThreadMessage)(await htmlResponse.json());
    expect(htmlMessage.textBody).toBe("text");
    expect(htmlMessage.htmlBody).toBe(
      '<p>safe</p><img src="/messages/message-html/attachments/attachment-1">',
    );

    const textResponse = await world.fetch(
      `http://umail.test/messages/${text.messageId}`,
      authorized(world),
    );
    expect(textResponse.status).toBe(200);
    const textMessage = await Schema.decodeUnknownPromise(ThreadMessage)(await textResponse.json());
    expect(textMessage.textBody).toBe("text");
    expect(textMessage.htmlBody).toBeNull();
  });

  it("includes nextCursor on getThread when a thread has more than 50 messages", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const first = await seedInboundMessage(world, mailbox.id, {
      id: "thread-page-0",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    for (let index = 1; index < 51; index += 1) {
      await seedInboundMessage(world, mailbox.id, {
        id: `thread-page-${index}`,
        occurredAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1000).toISOString(),
        inReplyToHeader: "<thread-page-0@example.com>",
      });
    }
    const response = await world.fetch(
      `http://umail.test/threads/${encodeURIComponent(first.threadHandle)}`,
      authorized(world),
    );
    expect(response.status).toBe(200);
    const detail = await Schema.decodeUnknownPromise(MailThreadDetail)(await response.json());
    expect(detail.messages).toHaveLength(50);
    expect(detail.nextCursor).not.toBeNull();
    expect(detail.messages.map((message) => message.id)).not.toContain("thread-page-50");
  });

  it("stores sanitized outbound HTML as a durable job without sending", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const response = await world.fetch("http://umail.test/submissions", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        intent: "compose",
        requestId: REQUEST_ID,
        fromAddressId: mailbox.id,
        to: [{ address: "recipient@example.com", displayName: null }],
        subject: "Sanitized",
        html: REMOTE_HTML_SOURCE,
      }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const job = await Schema.decodeUnknownPromise(OutboundJobStatus)(await response.json());
    expect(job.state).toBe("ready");
    expect(job.state).not.toBe("accepted");
    const messageResponse = await world.fetch(
      `http://umail.test/messages/${job.messageId}`,
      authorized(world),
    );
    const message = await Schema.decodeUnknownPromise(OutboundThreadMessage)(
      await messageResponse.json(),
    );
    expect(message.sendState).toBe("ready");
    expect(message.sendState).not.toBe("accepted");
    expect(message.htmlBody).toBe(REMOTE_HTML_STORED);
    expect(message.hasRemoteImages).toBe(true);
    expect(JSON.stringify(message)).not.toContain("sentBy");
  });

  it("returns a durable job from POST /messages without claiming acceptance", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const response = await world.fetch("http://umail.test/messages", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        intent: "compose",
        fromAddressId: mailbox.id,
        to: [{ address: "recipient@example.com", displayName: null }],
        subject: "Compose job",
        text: "body",
      }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const job = await Schema.decodeUnknownPromise(OutboundJobStatus)(await response.json());
    expect(job.state).toBe("ready");
    expect(job.state).not.toBe("accepted");
    expect(job.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
    const stored = await Schema.decodeUnknownPromise(OutboundThreadMessage)(
      await (
        await world.fetch(`http://umail.test/messages/${job.messageId}`, authorized(world))
      ).json(),
    );
    expect(stored.sendState).toBe("ready");
    expect(stored.direction).toBe("outbound");
  });

  it("uses the destination provider and persists its actor-free result", async () => {
    const world = await createWorld();
    const response = await world.fetch("http://umail.test/forwarding-destinations", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({ email: "forward@example.com" }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(world.destinations.createCalls).toEqual(["forward@example.com"]);
    const stored = await Effect.runPromise(world.account.listDestinations());
    expect(stored.map((destination) => destination.email)).toEqual(["forward@example.com"]);
    expect(stored[0]?.verificationStatus).toBe("pending");
  });

  it("paginates threads without duplicates and rejects malformed cursors", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const seeded = [];
    for (const [id, occurredAt] of [
      ["message-old", "2026-01-01T00:00:00.000Z"],
      ["message-a", "2026-01-02T00:00:00.000Z"],
      ["message-b", "2026-01-02T00:00:00.001Z"],
      ["message-new", "2026-01-03T00:00:00.000Z"],
    ] as const) {
      seeded.push(await seedInboundMessage(world, mailbox.id, { id, occurredAt }));
    }

    const firstResponse = await world.fetch("http://umail.test/threads?limit=2", authorized(world));
    expect(firstResponse.status).toBe(200);
    const first = await Schema.decodeUnknownPromise(MailThreadPage)(await firstResponse.json());
    expect(first.items.map((item) => item.threadId)).toEqual([
      seeded[3]?.threadHandle,
      seeded[2]?.threadHandle,
    ]);
    expect(first.nextCursor).not.toBeNull();

    const secondResponse = await world.fetch(
      `http://umail.test/threads?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
      authorized(world),
    );
    expect(secondResponse.status).toBe(200);
    const second = await Schema.decodeUnknownPromise(MailThreadPage)(await secondResponse.json());
    expect(second.items.map((item) => item.threadId)).toEqual([
      seeded[1]?.threadHandle,
      seeded[0]?.threadHandle,
    ]);
    expect(second.nextCursor).toBeNull();
    const allIds = [...first.items, ...second.items].map((item) => item.threadId);
    expect(new Set(allIds).size).toBe(4);

    for (const cursor of [
      "not-base64!",
      Buffer.from("missing separator").toString("base64url"),
      Buffer.from("not-a-date\nthread").toString("base64url"),
    ]) {
      const malformed = await world.fetch(
        `http://umail.test/threads?cursor=${encodeURIComponent(cursor)}`,
        authorized(world),
      );
      expect(malformed.status).toBe(400);
    }
  });

  it("gets, reads, unreads, and soft-deletes an inbound thread", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const inbound = await seedInboundMessage(world, mailbox.id);
    const threadPath = `/threads/${encodeURIComponent(inbound.threadHandle)}`;

    const initial = await world.fetch(`http://umail.test${threadPath}`, authorized(world));
    expect(initial.status).toBe(200);

    const read = await world.fetch(`http://umail.test${threadPath}/read`, {
      ...authorized(world),
      method: "PATCH",
    });
    expect(read.status).toBe(200);
    const readDetail = await Schema.decodeUnknownPromise(MailThreadDetail)(await read.json());
    expect(readDetail.messages[0]?.direction).toBe("inbound");
    if (readDetail.messages[0]?.direction === "inbound") {
      expect(readDetail.messages[0].isRead).toBe(true);
      expect(readDetail.messages[0].readAt).not.toBeNull();
    }

    const unread = await world.fetch(`http://umail.test${threadPath}/unread`, {
      ...authorized(world),
      method: "PATCH",
    });
    expect(unread.status).toBe(200);
    const unreadDetail = await Schema.decodeUnknownPromise(MailThreadDetail)(await unread.json());
    if (unreadDetail.messages[0]?.direction === "inbound") {
      expect(unreadDetail.messages[0].isRead).toBe(false);
    }

    const removed = await world.fetch(`http://umail.test${threadPath}`, {
      ...authorized(world),
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect((await world.fetch(`http://umail.test${threadPath}`, authorized(world))).status).toBe(
      404,
    );
  });

  it("plans reply-all recipients and submits a threaded reply job", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const target = await seedInboundMessage(world, mailbox.id, {
      id: "message-parent",
      to: [FROM_ADDRESS, "other@example.com"],
      cc: ["copy@example.com"],
    });

    const planResponse = await world.fetch(
      `http://umail.test/messages/${target.messageId}/reply-plan?mode=reply-all`,
      authorized(world),
    );
    expect(planResponse.status).toBe(200);
    const plan = await Schema.decodeUnknownPromise(ReplyPlan)(await planResponse.json());
    expect(plan.fromAddressId).toBe(mailbox.id);
    expect(plan.to.map((contact) => contact.address)).toEqual(["sender@example.com"]);
    expect(plan.cc.map((contact) => contact.address)).toEqual([
      "other@example.com",
      "copy@example.com",
    ]);

    const replyResponse = await world.fetch("http://umail.test/submissions", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        intent: "reply",
        requestId: REQUEST_ID,
        fromAddressId: mailbox.id,
        subject: "Re: parent",
        text: "reply body",
        replyToMessageId: target.messageId,
        replyMode: "reply-all",
      }),
    });
    expect(replyResponse.status, await replyResponse.clone().text()).toBe(200);
    const job = await Schema.decodeUnknownPromise(OutboundJobStatus)(await replyResponse.json());
    expect(job.state).toBe("ready");
    const thread = await Schema.decodeUnknownPromise(MailThreadDetail)(
      await (
        await world.fetch(
          `http://umail.test/threads/${encodeURIComponent(target.threadHandle)}`,
          authorized(world),
        )
      ).json(),
    );
    expect(thread.messages.map((message) => message.id)).toContain(job.messageId);
    const reply = await Schema.decodeUnknownPromise(OutboundThreadMessage)(
      await (
        await world.fetch(`http://umail.test/messages/${job.messageId}`, authorized(world))
      ).json(),
    );
    expect(reply.to.map((contact) => contact.address)).toEqual(
      plan.to.map((contact) => contact.address),
    );
  });

  it("threads a reply to our own accepted outbound message onto that message", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const sendResponse = await world.fetch("http://umail.test/submissions", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        intent: "compose",
        requestId: REQUEST_ID,
        fromAddressId: mailbox.id,
        to: [{ address: "recipient@example.com", displayName: null }],
        subject: "Hello",
        text: "outbound body",
      }),
    });
    expect(sendResponse.status, await sendResponse.clone().text()).toBe(200);
    const sent = await Schema.decodeUnknownPromise(OutboundJobStatus)(await sendResponse.json());

    const claimed = await Effect.runPromise(
      world.account.claimDispatch({
        jobId: sent.jobId,
        nowIso: "2026-01-01T00:00:00.000Z",
        claimExpiresAt: "2026-01-01T00:15:00.000Z",
      }),
    );
    if (claimed.kind !== "claimed") {
      throw new Error("expected a dispatch claim");
    }
    await Effect.runPromise(
      world.account.completeAttempt({
        jobId: sent.jobId,
        attemptId: claimed.attemptId,
        nowIso: "2026-01-01T00:00:01.000Z",
        outcome: {
          kind: "accepted",
          providerMessageId: "prov-1",
          rfcMessageId: PROVIDER_RFC_ID,
        },
      }),
    );

    const replyResponse = await world.fetch("http://umail.test/submissions", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        intent: "reply",
        requestId: REPLY_REQUEST_ID,
        fromAddressId: mailbox.id,
        subject: "Re: Hello",
        text: "reply body",
        replyToMessageId: sent.messageId,
        replyMode: "reply",
      }),
    });
    expect(replyResponse.status, await replyResponse.clone().text()).toBe(200);
    const replyJob = await Schema.decodeUnknownPromise(OutboundJobStatus)(
      await replyResponse.json(),
    );
    const reply = await Schema.decodeUnknownPromise(OutboundThreadMessage)(
      await (
        await world.fetch(`http://umail.test/messages/${replyJob.messageId}`, authorized(world))
      ).json(),
    );
    expect(reply.inReplyToRfcMessageId).toBe(PROVIDER_RFC_ID);
    expect(reply.parentMessageId).toBe(sent.messageId);
  });

  it("lists, reads and replaces MCP client policies over the JSON API", async () => {
    const world = await createWorld();
    await Effect.runPromise(
      world.account.ensureMcpOAuthPolicy({
        clientId: "agent-1",
        label: "Agent one",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const listed = await world.fetch("http://umail.test/mcp-clients", authorized(world));
    expect(listed.status, await listed.clone().text()).toBe(200);
    const clients = await Schema.decodeUnknownPromise(Schema.Array(McpClient))(await listed.json());
    const seeded = clients.find((entry) => entry.clientId === "agent-1");
    expect(seeded?.label).toBe("Agent one");
    expect(seeded?.policy.sendMode.kind).toBe("requireApproval");

    const updated = await world.fetch("http://umail.test/mcp-clients/agent-1/policy", {
      method: "PUT",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        label: "Agent one",
        active: true,
        policy: {
          mailboxIds: "all",
          canRead: true,
          canDelete: false,
          sendMode: { kind: "allow" },
          recipientAllowlist: "any",
          canAdmin: false,
        },
      }),
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const client = await Schema.decodeUnknownPromise(McpClient)(await updated.json());
    expect(client.policy.sendMode.kind).toBe("allow");
    expect(client.state).toBe("active");

    const stored = await Effect.runPromise(world.account.getMcpOAuthPolicy("agent-1"));
    expect(stored?.policy.sendMode.kind).toBe("allow");

    const fetched = await world.fetch("http://umail.test/mcp-clients/agent-1", authorized(world));
    expect(
      (await Schema.decodeUnknownPromise(McpClient)(await fetched.json())).policy.sendMode.kind,
    ).toBe("allow");

    const disabled = await world.fetch("http://umail.test/mcp-clients/agent-1/policy", {
      method: "PUT",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        label: "Agent one",
        active: false,
        policy: {
          mailboxIds: "all",
          canRead: true,
          canDelete: false,
          sendMode: { kind: "allow" },
          recipientAllowlist: "any",
          canAdmin: false,
        },
      }),
    });
    expect((await Schema.decodeUnknownPromise(McpClient)(await disabled.json())).state).toBe(
      "disabled",
    );
    expect((await Effect.runPromise(world.account.getMcpOAuthPolicy("agent-1")))?.state).toBe(
      "disabled",
    );
  });

  it("rejects an unauthenticated caller and a policy that would empty a required list", async () => {
    const world = await createWorld();
    await Effect.runPromise(
      world.account.ensureMcpOAuthPolicy({
        clientId: "agent-3",
        label: "Agent three",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const body = {
      label: "Agent three",
      active: true,
      policy: {
        mailboxIds: "all",
        canRead: true,
        canDelete: false,
        sendMode: { kind: "allow" },
        recipientAllowlist: "any",
        canAdmin: true,
      },
    };

    expect((await world.fetch("http://umail.test/mcp-clients", unauthorized())).status).toBe(401);
    const anonymousWrite = await world.fetch("http://umail.test/mcp-clients/agent-3/policy", {
      method: "PUT",
      headers: jsonHeaders(unauthorized().headers),
      body: JSON.stringify(body),
    });
    expect(anonymousWrite.status).toBe(401);
    expect(
      (await Effect.runPromise(world.account.getMcpOAuthPolicy("agent-3")))?.policy.canAdmin,
    ).toBe(false);

    for (const invalid of [
      { ...body, policy: { ...body.policy, mailboxIds: [] } },
      { ...body, policy: { ...body.policy, recipientAllowlist: [] } },
    ]) {
      const response = await world.fetch("http://umail.test/mcp-clients/agent-3/policy", {
        method: "PUT",
        headers: jsonHeaders(authorized(world).headers),
        body: JSON.stringify(invalid),
      });
      expect(response.status, await response.clone().text()).toBe(400);
    }
    expect(
      (await Effect.runPromise(world.account.getMcpOAuthPolicy("agent-3")))?.policy.sendMode.kind,
    ).toBe("requireApproval");
  });

  it("refuses an unknown client and never restores a revoked one", async () => {
    const world = await createWorld();
    expect(
      (await world.fetch("http://umail.test/mcp-clients/nobody", authorized(world))).status,
    ).toBe(404);

    await Effect.runPromise(
      world.account.ensureMcpOAuthPolicy({
        clientId: "agent-2",
        label: "Agent two",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      world.account.revokeMcpOAuthPolicy("agent-2", "2026-01-02T00:00:00.000Z"),
    );
    const revoked = await world.fetch("http://umail.test/mcp-clients/agent-2/policy", {
      method: "PUT",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        label: "Agent two",
        active: true,
        policy: {
          mailboxIds: "all",
          canRead: true,
          canDelete: false,
          sendMode: { kind: "allow" },
          recipientAllowlist: "any",
          canAdmin: false,
        },
      }),
    });
    expect(revoked.status).toBe(400);
    const stored = await Effect.runPromise(world.account.getMcpOAuthPolicy("agent-2"));
    expect(stored?.state).toBe("revoked");
    expect(stored?.policy.sendMode.kind).toBe("requireApproval");
  });

  it("returns reply errors without creating a job", async () => {
    const world = await createWorld();
    const missing = await world.fetch(
      "http://umail.test/messages/missing/reply-plan?mode=reply",
      authorized(world),
    );
    expect(missing.status).toBe(404);
    const jobs = await Effect.runPromise(
      world.account.listOutboundJobs({ viewer: { kind: "operator" } }),
    );
    expect(jobs.items).toEqual([]);
  });

  it("associates and removes only verified forwarding destinations", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const now = "2026-01-01T00:00:00.000Z";
    const verified = await Effect.runPromise(
      world.account.insertDestination("cf-verified", "verified@example.com", now, now),
    );
    const pending = await Effect.runPromise(
      world.account.insertDestination("cf-pending", "pending@example.com", null, now),
    );

    const rejected = await world.fetch(`http://umail.test/addresses/${mailbox.id}/forwarding`, {
      method: "PUT",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({ destinationId: pending.id }),
    });
    expect(rejected.status).toBe(400);

    const associated = await world.fetch(`http://umail.test/addresses/${mailbox.id}/forwarding`, {
      method: "PUT",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({ destinationId: verified.id }),
    });
    expect(associated.status).toBe(200);
    const afterAssociate = await Effect.runPromise(world.account.getAddress(mailbox.id));
    expect(afterAssociate?.forwardingDestinationId).toBe(verified.id);

    const removed = await world.fetch(`http://umail.test/addresses/${mailbox.id}/forwarding`, {
      ...authorized(world),
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const afterRemove = await Effect.runPromise(world.account.getAddress(mailbox.id));
    expect(afterRemove?.forwardingDestinationId).toBeNull();
  });

  it("refreshes, lists, gets, and deletes destinations with provider semantics", async () => {
    const world = await createWorld();
    const createdResponse = await world.fetch("http://umail.test/forwarding-destinations", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({ email: "lifecycle@example.com" }),
    });
    expect(createdResponse.status).toBe(200);
    const created = await Schema.decodeUnknownPromise(ForwardingDestination)(
      await createdResponse.json(),
    );
    const cloudflareId =
      world.destinations.createCalls.length === 1
        ? [...world.destinations.items.keys()][0]
        : undefined;
    expect(cloudflareId).toBeDefined();
    if (cloudflareId === undefined) return;
    world.destinations.items.set(cloudflareId, {
      cloudflareId,
      email: "lifecycle@example.com",
      verifiedAt: "2026-02-01T00:00:00.000Z",
    });

    const listed = await world.fetch(
      "http://umail.test/forwarding-destinations",
      authorized(world),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([created]);

    const refreshed = await world.fetch(
      `http://umail.test/forwarding-destinations/${created.id}`,
      authorized(world),
    );
    expect(refreshed.status).toBe(200);
    const refreshedDestination = await Schema.decodeUnknownPromise(ForwardingDestination)(
      await refreshed.json(),
    );
    expect(refreshedDestination.verificationStatus).toBe("verified");
    expect(world.destinations.getCalls).toEqual([cloudflareId]);

    const removed = await world.fetch(`http://umail.test/forwarding-destinations/${created.id}`, {
      ...authorized(world),
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect(world.destinations.deleteCalls).toEqual([cloudflareId]);
    expect(await Effect.runPromise(world.account.listDestinations())).toEqual([]);

    world.destinations.failNext("This email address is already in use.");
    const rejected = await world.fetch("http://umail.test/forwarding-destinations", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({ email: "duplicate@example.com" }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      _tag: "ApiProblem",
      message: "This email address is already in use.",
    });
  });

  it("keeps a local destination when the provider refuses deletion", async () => {
    const world = await createWorld();
    const createdResponse = await world.fetch("http://umail.test/forwarding-destinations", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({ email: "keep@example.com" }),
    });
    const created = await Schema.decodeUnknownPromise(ForwardingDestination)(
      await createdResponse.json(),
    );
    world.destinations.failNext("Provider refused deletion.");
    const removed = await world.fetch(`http://umail.test/forwarding-destinations/${created.id}`, {
      ...authorized(world),
      method: "DELETE",
    });
    expect(removed.status).toBe(400);
    const remaining = await Effect.runPromise(world.account.getDestination(created.id));
    expect(remaining?.id).toBe(created.id);
  });

  it("serves exact attachment bytes and does not map archive transport failure to NotFound", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const inbound = await seedInboundMessage(world, mailbox.id, {
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

    const absentRow = await world.fetch(
      `http://umail.test/messages/${inbound.messageId}/attachments/missing`,
      authorized(world),
    );
    expect(absentRow.status).toBe(404);
    expect(world.archive.getCalls).toEqual([]);

    const absentObject = await world.fetch(
      `http://umail.test/messages/${inbound.messageId}/attachments/attachment-1`,
      authorized(world),
    );
    expect(absentObject.status).toBe(404);
    expect(world.archive.getCalls).toEqual(["mail/attachment.bin"]);

    world.archive.failNextTransport();
    const transport = await world.fetch(
      `http://umail.test/messages/${inbound.messageId}/attachments/attachment-1`,
      authorized(world),
    );
    expect(transport.status).toBe(502);
    expect(transport.status).not.toBe(404);

    world.archive.put("mail/attachment.bin", new Uint8Array([0, 1, 2, 255]));
    const found = await world.fetch(
      `http://umail.test/messages/${inbound.messageId}/attachments/attachment-1`,
      authorized(world),
    );
    expect(found.status).toBe(200);
    expect(new Uint8Array(await found.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(found.headers.get("content-type")).toBe("application/octet-stream");
    expect(found.headers.get("content-disposition")).toContain("attachment.bin");
    expect(found.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves exact archived source bytes as a download and maps archive faults to 502", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const inbound = await seedInboundMessage(world, mailbox.id, { id: "source-in" });
    const source = new Uint8Array([
      ...new TextEncoder().encode("Subject: raw\r\n\r\n"),
      0x00,
      0xff,
      0xfe,
      0x80,
      0x0a,
    ]);
    const sourcePath = `http://umail.test/messages/${inbound.messageId}/source`;

    const absentObject = await world.fetch(sourcePath, authorized(world));
    expect(absentObject.status).toBe(404);
    expect(world.archive.getCalls).toEqual(["raw/source-in"]);

    world.archive.put("raw/source-in", source);
    world.archive.failNextTransport();
    const transport = await world.fetch(sourcePath, authorized(world));
    expect(transport.status).toBe(502);
    expect(transport.status).not.toBe(404);

    const found = await world.fetch(sourcePath, authorized(world));
    expect(found.status).toBe(200);
    expect(new Uint8Array(await found.arrayBuffer())).toEqual(source);
    expect(found.headers.get("content-type")).toBe("message/rfc822");
    expect(found.headers.get("content-disposition")).toBe(
      `attachment; filename="source-in.eml"; filename*=UTF-8''source-in.eml`,
    );
    expect(found.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 409 for outbound and 404 for unknown or soft-deleted message source", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const inbound = await seedInboundMessage(world, mailbox.id, { id: "deleted-in" });
    world.archive.put("raw/deleted-in", new Uint8Array([1, 2, 3]));
    const sendResponse = await world.fetch("http://umail.test/submissions", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        intent: "compose",
        requestId: REQUEST_ID,
        fromAddressId: mailbox.id,
        to: [{ address: "recipient@example.com", displayName: null }],
        subject: "Outbound",
        text: "outbound body",
      }),
    });
    expect(sendResponse.status).toBe(200);
    const job = await Schema.decodeUnknownPromise(OutboundJobStatus)(await sendResponse.json());

    const outbound = await world.fetch(
      `http://umail.test/messages/${job.messageId}/source`,
      authorized(world),
    );
    expect(outbound.status).toBe(409);
    expect(await outbound.json()).toEqual({ _tag: "OutboundMessageHasNoSource" });

    const unknown = await world.fetch(
      "http://umail.test/messages/unknown/source",
      authorized(world),
    );
    expect(unknown.status).toBe(404);

    const removed = await world.fetch(
      `http://umail.test/threads/${encodeURIComponent(inbound.threadHandle)}`,
      { ...authorized(world), method: "DELETE" },
    );
    expect(removed.status).toBe(204);
    const deleted = await world.fetch(
      `http://umail.test/messages/${inbound.messageId}/source`,
      authorized(world),
    );
    expect(deleted.status).toBe(404);
    expect(world.archive.getCalls).toEqual([]);
  });

  it("reads no archived source before the principal is authorized and in scope", async () => {
    const world = await createWorld();
    const inbox = await seedMailbox(world, "inbox");
    const probe = await seedMailbox(world, "probe");
    const inbound = await seedInboundMessage(world, inbox.id, { id: "scoped-in" });
    world.archive.put("raw/scoped-in", new Uint8Array([1, 2, 3]));

    const wrongBearer = await world.fetch(
      `http://umail.test/messages/${inbound.messageId}/source`,
      unauthorized(),
    );
    expect(wrongBearer.status).toBe(401);

    const outOfScope = await storedMcpPrincipal(world, "out-of-scope-reader", {
      mailboxIds: [probe.id],
      canRead: true,
    });
    await expect(
      Effect.runPromise(readMessageSource(world.deps, outOfScope, inbound.messageId)),
    ).rejects.toMatchObject({ _tag: "NotFound" });

    const cannotRead = await storedMcpPrincipal(world, "no-read-client", {
      mailboxIds: "all",
      canRead: false,
    });
    await expect(
      Effect.runPromise(readMessageSource(world.deps, cannotRead, inbound.messageId)),
    ).rejects.toMatchObject({ _tag: "Forbidden" });

    expect(world.archive.getCalls).toEqual([]);
  });

  it("lists last-24h inbound, address, unread, and pages by cursor", async () => {
    const world = await createWorld();
    const inbox = await seedMailbox(world, "inbox");
    const probe = await seedMailbox(world, "probe");
    await seedInboundMessage(world, inbox.id, {
      id: "old-in",
      occurredAt: "2026-08-24T10:00:00.000Z",
    });
    const recent = await seedInboundMessage(world, inbox.id, {
      id: "recent-in",
      occurredAt: "2026-08-25T18:00:00.000Z",
    });
    await seedInboundMessage(world, probe.id, {
      id: "probe-in",
      occurredAt: "2026-08-25T19:00:00.000Z",
    });
    const sendResponse = await world.fetch("http://umail.test/submissions", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({
        intent: "compose",
        requestId: REQUEST_ID,
        fromAddressId: inbox.id,
        to: [{ address: "recipient@example.com", displayName: null }],
        subject: "Outbound",
        text: "outbound body",
      }),
    });
    expect(sendResponse.status, await sendResponse.clone().text()).toBe(200);

    const since = "2026-08-25T00:00:00.000Z";
    const inboundResponse = await world.fetch(
      `http://umail.test/messages?direction=inbound&since=${encodeURIComponent(since)}`,
      authorized(world),
    );
    expect(inboundResponse.status).toBe(200);
    const inbound = await Schema.decodeUnknownPromise(MailMessagePage)(
      await inboundResponse.json(),
    );
    expect(inbound.items.map((item) => item.id)).toEqual(["probe-in", recent.messageId]);
    expect(JSON.stringify(inbound)).not.toContain("textBody");
    expect(JSON.stringify(inbound)).not.toContain("htmlBody");
    expect(JSON.stringify(inbound)).not.toContain("outbound body");

    const addressResponse = await world.fetch(
      `http://umail.test/messages?addressId=${encodeURIComponent(inbox.id)}`,
      authorized(world),
    );
    expect(addressResponse.status).toBe(200);
    const byAddress = await Schema.decodeUnknownPromise(MailMessagePage)(
      await addressResponse.json(),
    );
    expect(byAddress.items.every((item) => item.addressId === inbox.id)).toBe(true);
    expect(byAddress.items.map((item) => item.id)).not.toContain("probe-in");

    await Effect.runPromise(
      world.account.markThreadRead(recent.threadHandle, true, "all", "2026-08-25T18:01:00.000Z"),
    );
    const unreadResponse = await world.fetch(
      "http://umail.test/messages?unread=true",
      authorized(world),
    );
    expect(unreadResponse.status).toBe(200);
    const unread = await Schema.decodeUnknownPromise(MailMessagePage)(await unreadResponse.json());
    expect(unread.items.map((item) => item.id)).toEqual(["probe-in", "old-in"]);
    expect(unread.items.every((item) => item.direction === "inbound")).toBe(true);

    const firstResponse = await world.fetch(
      "http://umail.test/messages?limit=2",
      authorized(world),
    );
    expect(firstResponse.status).toBe(200);
    const first = await Schema.decodeUnknownPromise(MailMessagePage)(await firstResponse.json());
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const secondResponse = await world.fetch(
      `http://umail.test/messages?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
      authorized(world),
    );
    expect(secondResponse.status).toBe(200);
    const second = await Schema.decodeUnknownPromise(MailMessagePage)(await secondResponse.json());
    const pagedIds = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(pagedIds).size).toBe(pagedIds.length);
    expect(pagedIds).toEqual(expect.arrayContaining(["probe-in", recent.messageId, "old-in"]));

    for (const cursor of [
      "not-base64!",
      Buffer.from("missing separator").toString("base64url"),
      Buffer.from("not-a-date\nmessage").toString("base64url"),
    ]) {
      const malformed = await world.fetch(
        `http://umail.test/messages?cursor=${encodeURIComponent(cursor)}`,
        authorized(world),
      );
      expect(malformed.status).toBe(400);
    }
  });

  it("replays an identical submission key and conflicts on a changed payload", async () => {
    const world = await createWorld();
    const mailbox = await seedMailbox(world);
    const body = {
      intent: "compose",
      requestId: REQUEST_ID,
      fromAddressId: mailbox.id,
      to: [{ address: "recipient@example.com", displayName: null }],
      subject: "Hello",
      text: "body",
    };
    const first = await world.fetch("http://umail.test/submissions", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify(body),
    });
    const replay = await world.fetch("http://umail.test/submissions", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify(body),
    });
    const conflict = await world.fetch("http://umail.test/submissions", {
      method: "POST",
      headers: jsonHeaders(authorized(world).headers),
      body: JSON.stringify({ ...body, subject: "Changed" }),
    });
    const firstJob = await Schema.decodeUnknownPromise(OutboundJobStatus)(await first.json());
    const replayJob = await Schema.decodeUnknownPromise(OutboundJobStatus)(await replay.json());
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replayJob.jobId).toBe(firstJob.jobId);
    expect(conflict.status).toBe(409);
    const listed = await world.fetch("http://umail.test/jobs", authorized(world));
    const page = Schema.decodeUnknownSync(
      Schema.Struct({ items: Schema.Array(OutboundJobStatus) }),
    )(await listed.json());
    expect(page.items.map((item) => item.jobId)).toEqual([firstJob.jobId]);
  });
});

type StoredMcpReadAccess = Pick<PrincipalPolicy, "mailboxIds" | "canRead">;

async function storedMcpPrincipal(
  world: World,
  clientId: string,
  access: StoredMcpReadAccess,
): Promise<McpPrincipal> {
  const policy = {
    mailboxIds: access.mailboxIds,
    canRead: access.canRead,
    canDelete: false,
    sendMode: { kind: "deny" },
    recipientAllowlist: "any",
    canAdmin: false,
  } satisfies PrincipalPolicy;
  await Effect.runPromise(
    world.account.ensureMcpOAuthPolicy({
      clientId,
      label: clientId,
      createdAt: "2026-08-28T10:00:00.000Z",
    }),
  );
  await Effect.runPromise(
    world.account.updateMcpOAuthPolicy({
      clientId,
      label: clientId,
      policy,
      updatedAt: "2026-08-28T10:01:00.000Z",
    }),
  );
  return {
    authority: "mcp",
    identity: { kind: "oauth", userId: world.operatorId, clientId, clientLabel: clientId },
    policy,
  };
}
