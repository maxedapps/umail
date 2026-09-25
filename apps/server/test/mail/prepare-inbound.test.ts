import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  INBOUND_MIME_LIMITS,
  MAX_ATTACHMENTS,
  MAX_PERSISTED_MESSAGE_BYTES,
} from "../../src/mail/policy.ts";
import { prepareInbound, type PreparedInbound } from "../../src/mail/process-index.ts";
import { FakeMailHtmlPolicy } from "./fakes.ts";

const INBOX = "inbox@umail.example.com";
const SENDER = "sender@example.com";
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TEST_NOW_ISO = "2026-01-01T00:00:00.000Z";
const RECEIVED_AT = "2025-12-31T23:59:00.000Z";
const RECEIPT_ID = "in_prepare";

describe("prepareInbound", () => {
  it.effect("builds the AccountStore write with the sanitizer result", () =>
    Effect.gen(function* () {
      const prepared = ready(
        yield* prepare(plainHtmlEml(INBOX, "<html><body><p>Hi</p></body></html>")),
      );

      expect(prepared.input).toMatchObject({
        messageId: RECEIPT_ID,
        mailboxId: "addr-1",
        occurredAt: RECEIVED_AT,
        nowIso: TEST_NOW_ISO,
        subject: "Hello",
        htmlBody: expect.stringContaining("<p>Hi</p>"),
        hasRemoteImages: false,
        attachments: [],
      });
      expect(prepared.attachments).toEqual([]);
    }),
  );

  it.effect("normalizes supported MIME dates and stores null for absent or unparseable dates", () =>
    Effect.gen(function* () {
      const cases = [
        {
          label: "valid offset",
          dateHeader: "Tue, 25 Aug 2026 12:00:00 +0200",
          parsedDate: "2026-08-25T10:00:00.000Z",
        },
        { label: "absent", dateHeader: null, parsedDate: null },
        { label: "invalid", dateHeader: "not a date", parsedDate: null },
      ] as const;
      for (const fixture of cases) {
        const prepared = ready(yield* prepare(datedTextEml(INBOX, fixture.dateHeader)));
        expect(prepared.input.parsedDate, fixture.label).toBe(fixture.parsedDate);
        expect(prepared.input.occurredAt, fixture.label).toBe(RECEIVED_AT);
      }
    }),
  );

  it.effect("passes deterministic attachment metadata to the sanitizer", () =>
    Effect.gen(function* () {
      const htmlPolicy = new FakeMailHtmlPolicy();
      htmlPolicy.setOutput("<p>sanitized CID body</p>", true);

      const prepared = ready(yield* prepare(relatedImageEml(INBOX), htmlPolicy));

      const attachment = prepared.input.attachments?.[0];
      expect(prepared.input.attachments).toHaveLength(1);
      expect(attachment).toMatchObject({
        filename: "logo.png",
        mimeType: "image/png",
        r2Key: `attachments/${RECEIPT_ID}/0`,
        isInline: true,
      });
      expect(prepared.attachments.map((upload) => upload.r2Key)).toEqual([attachment?.r2Key]);
      expect(prepared.input.htmlBody).toBe("<p>sanitized CID body</p>");
      expect(prepared.input.hasRemoteImages).toBe(true);
      expect(htmlPolicy.calls.map((call) => call.sanitization)).toEqual([
        {
          messageId: RECEIPT_ID,
          attachments: [{ id: attachment?.id, contentId: "logo@umail", mimeType: "image/png" }],
        },
      ]);
    }),
  );

  it.effect.each(["rewrite_failed", "resource_exhausted"] as const)(
    "indexes the message text-only when the sanitizer fails with %s",
    (reason) =>
      Effect.gen(function* () {
        const htmlPolicy = new FakeMailHtmlPolicy();
        htmlPolicy.fail(reason);

        const prepared = ready(yield* prepare(alternativeEml(INBOX), htmlPolicy));

        expect(prepared.input.htmlBody).toBeNull();
        expect(prepared.input.hasRemoteImages).toBe(false);
        expect(prepared.input.textBody).toContain("Plain part");
      }),
  );

  it.effect("enforces the exact aggregate MIME header boundary", () =>
    Effect.gen(function* () {
      ready(yield* prepare(headerSizedEml(INBOX, INBOUND_MIME_LIMITS.maxHeadersSize)));
      expect(yield* prepare(headerSizedEml(INBOX, INBOUND_MIME_LIMITS.maxHeadersSize + 1))).toEqual(
        policyFailure("parse_failed"),
      );
    }),
  );

  it.effect("enforces the exact MIME tree-depth boundary", () =>
    Effect.gen(function* () {
      ready(yield* prepare(nestedMultipartEml(INBOX, INBOUND_MIME_LIMITS.maxNestingDepth)));
      expect(
        yield* prepare(nestedMultipartEml(INBOX, INBOUND_MIME_LIMITS.maxNestingDepth + 1)),
      ).toEqual(policyFailure("parse_failed"));
    }),
  );

  it.effect("rejects the PostalMime RFC822 depth marker at the configured boundary", () =>
    Effect.gen(function* () {
      ready(yield* prepare(nestedRfc822Eml(INBOX, INBOUND_MIME_LIMITS.maxRfc822NestingDepth)));
      expect(
        yield* prepare(nestedRfc822Eml(INBOX, INBOUND_MIME_LIMITS.maxRfc822NestingDepth + 1)),
      ).toEqual(policyFailure("rfc822_depth"));
    }),
  );

  it.effect("rejects a post-sanitizer body that exceeds the persisted message budget", () =>
    Effect.gen(function* () {
      const allowed = new FakeMailHtmlPolicy();
      allowed.setOutput("ok");
      ready(yield* prepare(relatedImageEml(INBOX), allowed));

      const exceeded = new FakeMailHtmlPolicy();
      exceeded.setOutput("x".repeat(MAX_PERSISTED_MESSAGE_BYTES + 1));
      expect(yield* prepare(relatedImageEml(INBOX), exceeded)).toEqual(
        policyFailure("message_budget"),
      );
    }),
  );

  it.effect("enforces the exact attachment-count boundary", () =>
    Effect.gen(function* () {
      const allowed = ready(yield* prepare(attachmentCountEml(INBOX, MAX_ATTACHMENTS)));
      expect(allowed.input.attachments).toHaveLength(MAX_ATTACHMENTS);
      expect(new Set(allowed.attachments.map((upload) => upload.r2Key)).size).toBe(MAX_ATTACHMENTS);

      expect(yield* prepare(attachmentCountEml(INBOX, MAX_ATTACHMENTS + 1))).toEqual(
        policyFailure("attachment_cap"),
      );
    }),
  );

  it.effect("keeps raw threading headers and parsed contacts", () =>
    Effect.gen(function* () {
      const prepared = ready(yield* prepare(threadedEml(INBOX)));

      expect(prepared.input.rfcMessageId).toBe("<child@example.com>");
      expect(prepared.input.inReplyToHeader).toBe("<parent@example.com>");
      expect(prepared.input.referencesHeader).toBe("<root@example.com> <parent@example.com>");
      expect(prepared.input.from?.map((contact) => contact.address)).toEqual([SENDER]);
      expect(prepared.input.replyTo?.map((contact) => contact.address)).toEqual([
        "replies@example.com",
      ]);
      expect(prepared.input.to?.map((contact) => contact.address)).toEqual([INBOX]);
      expect(prepared.input.cc?.map((contact) => contact.address)).toEqual(["cc@example.com"]);
    }),
  );
});

function prepare(raw: Uint8Array, htmlPolicy = new FakeMailHtmlPolicy()) {
  return prepareInbound(
    raw.slice().buffer,
    { messageId: RECEIPT_ID, mailboxId: "addr-1", occurredAt: RECEIVED_AT, nowIso: TEST_NOW_ISO },
    htmlPolicy,
  );
}

function ready(prepared: PreparedInbound) {
  if (prepared.kind !== "ready") {
    throw new Error(`expected a ready message, got policy failure ${prepared.reason}`);
  }
  return prepared;
}

function policyFailure(reason: string) {
  return { kind: "policy_failed", reason };
}

function encodeEml(value: string): Uint8Array {
  return new TextEncoder().encode(value.replaceAll("\n", "\r\n"));
}

function plainHtmlEml(to: string, html: string): Uint8Array {
  return encodeEml(
    [
      `From: ${SENDER}`,
      `To: ${to}`,
      "Subject: Hello",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      "",
    ].join("\n"),
  );
}

function alternativeEml(to: string): Uint8Array {
  return encodeEml(
    [
      `From: ${SENDER}`,
      `To: ${to}`,
      "Subject: Alternative",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plain part",
      "--alt",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>HTML part</p>",
      "--alt--",
      "",
    ].join("\n"),
  );
}

function datedTextEml(to: string, dateHeader: string | null): Uint8Array {
  const headers = [
    `From: ${SENDER}`,
    `To: ${to}`,
    "Subject: Dated",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (dateHeader !== null) {
    headers.push(`Date: ${dateHeader}`);
  }
  return encodeEml([...headers, "", "body", ""].join("\n"));
}

function headerSizedEml(to: string, headerBytes: number): Uint8Array {
  const fixed = [
    `From: ${SENDER}`,
    `To: ${to}`,
    "Subject: Header boundary",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  const fixedBytes = fixed.reduce((total, line) => total + utf8Bytes(line), 0);
  return encodeEml(
    [...fixed, ...headerPadLines(headerBytes - fixedBytes), "", "body", ""].join("\n"),
  );
}

function headerPadLines(targetBytes: number): string[] {
  const maxPhysical = Math.min(76, INBOUND_MIME_LIMITS.maxLineLength);
  const lines: string[] = [];
  let remaining = targetBytes;
  while (remaining > 0) {
    const prefix = lines.length === 0 ? "X-Pad: " : " ";
    const prefixLen = utf8Bytes(prefix);
    const lineLen = Math.min(maxPhysical, remaining);
    if (lineLen <= prefixLen) {
      const last = lines.at(-1);
      if (last === undefined) {
        lines.push("x".repeat(lineLen));
      } else {
        lines[lines.length - 1] = last + "x".repeat(lineLen);
      }
      break;
    }
    lines.push(`${prefix}${"x".repeat(lineLen - prefixLen)}`);
    remaining -= lineLen;
  }
  return lines;
}

function nestedMultipartEml(to: string, maximumDepth: number): Uint8Array {
  const lines = [`From: ${SENDER}`, `To: ${to}`, "Subject: MIME depth", "MIME-Version: 1.0"];
  appendMimeNode(lines, 0, maximumDepth);
  return encodeEml([...lines, ""].join("\n"));
}

function appendMimeNode(lines: string[], depth: number, maximumDepth: number): void {
  if (depth === maximumDepth) {
    lines.push("Content-Type: text/plain; charset=utf-8", "", "body");
    return;
  }
  const boundary = `depth-${String(depth)}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`);
  appendMimeNode(lines, depth + 1, maximumDepth);
  lines.push(`--${boundary}--`);
}

function nestedRfc822Eml(to: string, depth: number): Uint8Array {
  let message = [
    `From: ${SENDER}`,
    `To: ${to}`,
    "Subject: RFC822 leaf",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "leaf",
  ].join("\n");
  for (let level = 0; level < depth; level++) {
    message = [
      `From: ${SENDER}`,
      `To: ${to}`,
      `Subject: RFC822 level ${String(level)}`,
      "MIME-Version: 1.0",
      "Content-Type: message/rfc822",
      "Content-Disposition: inline",
      "",
      message,
    ].join("\n");
  }
  return encodeEml(`${message}\n`);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function threadedEml(to: string): Uint8Array {
  return encodeEml(
    [
      `From: ${SENDER}`,
      `To: ${to}`,
      "Cc: cc@example.com",
      "Subject: Re: Hello",
      "Message-ID: <child@example.com>",
      "In-Reply-To: <parent@example.com>",
      "References: <root@example.com> <parent@example.com>",
      "Reply-To: replies@example.com",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Thanks",
      "",
    ].join("\n"),
  );
}

function relatedImageEml(to: string): Uint8Array {
  return encodeEml(
    [
      `From: ${SENDER}`,
      `To: ${to}`,
      "Subject: Logo",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="bound1"',
      "",
      "--bound1",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><body><img src="cid:logo@umail"></body></html>',
      "--bound1",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: inline; filename="logo.png"',
      "Content-ID: <logo@umail>",
      "",
      PNG_1X1_BASE64,
      "--bound1--",
      "",
    ].join("\n"),
  );
}

function attachmentCountEml(to: string, count: number): Uint8Array {
  const lines = [
    `From: ${SENDER}`,
    `To: ${to}`,
    "Subject: Cap",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body",
  ];
  for (let index = 0; index < count; index++) {
    lines.push(
      "--b1",
      "Content-Type: text/plain",
      `Content-Disposition: attachment; filename="part-${String(index)}.txt"`,
      "",
      `part-${String(index)}`,
    );
  }
  lines.push("--b1--", "");
  return encodeEml(lines.join("\n"));
}
