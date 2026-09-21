import type { AccountAddress } from "../../src/account/domain.ts";
import { parseMailboxAddress } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { processInbound } from "../../src/mail/inbound.ts";
import {
  DEFAULT_MAX_RAW_BYTES,
  INBOUND_MIME_LIMITS,
  MAX_ATTACHMENTS,
  MAX_PERSISTED_MESSAGE_BYTES,
} from "../../src/mail/policy.ts";
import { ReceiptManifest } from "../../src/mail/archive.ts";
import { consumeIndexReceipt } from "../../src/mail/process-index.ts";
import { FakeEmail, FakeMailHtmlPolicy, MemoryArchive, MemoryIndex } from "./fakes.ts";
import { MailCapacityAccount } from "./mail-capacity-support.ts";

const INBOX = "inbox@umail.example.com";
const SENDER = "sender@example.com";
const FORWARD_DEST = "owner@example.com";
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TEST_NOW_ISO = "2026-01-01T00:00:00.000Z";
const CLAIM_UNTIL_ISO = "2026-01-01T00:15:00.000Z";
const ADDRESS_ID = "addr-1";

describe("inbound pipeline", () => {
  it("accepts a plain message and stores the sanitizer result", async () => {
    const world = createWorld();
    seedAddress(world.account, INBOX);

    const raw = plainHtmlEml(INBOX, `<html><body><p>Hi</p></body></html>`);
    const email = new FakeEmail({ to: "Inbox@UMail.Example.COM", from: SENDER, raw });
    const accepted = await processInbound(email, world.ports);

    expect(accepted.kind).toBe("accepted");
    expect(email.rejectReason).toBeNull();
    await consumeQueued(world);

    expect(world.account.accepted).toHaveLength(1);
    const message = world.account.accepted[0];
    expect(message).toBeDefined();
    if (message === undefined) return;
    expect(message.htmlBody).toEqual(expect.stringContaining("<p>Hi</p>"));
    expect(world.archive.objects.has(firstRawKey(world))).toBe(true);
  });

  it("normalizes supported MIME dates and stores null for absent or unparseable dates", async () => {
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
      const world = createWorld();
      seedAddress(world.account, INBOX);
      await processInbound(
        new FakeEmail({
          to: INBOX,
          from: SENDER,
          raw: datedTextEml(INBOX, fixture.dateHeader),
        }),
        world.ports,
      );
      await consumeQueued(world);

      expect(world.account.accepted, fixture.label).toHaveLength(1);
      expect(world.account.accepted[0]?.parsedDate, fixture.label).toBe(fixture.parsedDate);
      expect(world.account.accepted[0]?.occurredAt, fixture.label).toBe(TEST_NOW_ISO);
    }
  });

  it("passes deterministic attachment metadata to the sanitizer", async () => {
    const world = createWorld();
    seedAddress(world.account, INBOX);

    const raw = relatedImageEml(INBOX);
    const email = new FakeEmail({ to: INBOX, from: SENDER, raw });
    await processInbound(email, world.ports);
    world.htmlPolicy.setOutput("<p>sanitized CID body</p>", true);
    await consumeQueued(world);

    expect(world.account.accepted).toHaveLength(1);
    const message = world.account.accepted[0];
    expect(message).toBeDefined();
    if (message === undefined) return;
    expect(message.attachments ?? []).toHaveLength(1);
    const attachment = message.attachments?.[0];
    expect(attachment).toBeDefined();
    if (attachment === undefined) return;
    expect(attachment.filename).toBe("logo.png");
    expect(attachment.mimeType).toBe("image/png");
    expect(world.archive.objects.has(attachment.r2Key)).toBe(true);
    expect(message.htmlBody).toBe("<p>sanitized CID body</p>");
    expect(message.hasRemoteImages).toBe(true);
    expect(world.htmlPolicy.calls).toHaveLength(1);
    expect(world.htmlPolicy.calls[0]?.sanitization).toEqual({
      messageId: message.messageId,
      attachments: [
        {
          id: attachment.id,
          contentId: "logo@umail",
          mimeType: "image/png",
        },
      ],
    });
  });

  it("classifies native sanitizer failure as deterministic content policy failure", async () => {
    const world = createWorld();
    seedAddress(world.account, INBOX);
    world.htmlPolicy.fail();

    await processInbound(
      new FakeEmail({ to: INBOX, from: SENDER, raw: relatedImageEml(INBOX) }),
      world.ports,
    );
    await consumeQueued(world);

    expect(world.account.accepted).toEqual([]);
    expect(world.account.policyFailures).toEqual([
      { receiptId: expect.stringMatching(/^in_/), reason: "sanitize_failed" },
    ]);
    expect(derivedObjectKeys(world)).toHaveLength(0);
    expect(rawObjectKeys(world)).toHaveLength(1);
  });

  it("records HTML resource exhaustion as terminal MIME budget failure before derived writes", async () => {
    const world = createWorld();
    seedAddress(world.account, INBOX);
    world.htmlPolicy.fail("resource_exhausted");

    await processInbound(
      new FakeEmail({ to: INBOX, from: SENDER, raw: relatedImageEml(INBOX) }),
      world.ports,
    );
    await consumeQueued(world);

    await expectPolicyFailure(world, "mime_budget");
    const receipt = [...world.account.receipts.values()][0];
    expect(receipt).toMatchObject({
      workState: "policy_failed",
      policyError: "mime_budget",
    });
    if (receipt === undefined) {
      throw new Error("expected inbound receipt");
    }
    const manifestBytes = world.archive.objects.get(receipt.manifestKey);
    expect(manifestBytes).toBeDefined();
    if (manifestBytes === undefined) {
      throw new Error("expected receipt manifest");
    }
    const manifest = Schema.decodeSync(Schema.fromJsonString(ReceiptManifest))(
      new TextDecoder().decode(manifestBytes),
    );
    expect(manifest.policyFailure).toBe("mime_budget");
    expect(world.archive.observedStorePutKeys).toEqual([receipt.manifestKey]);
  });

  it("enforces the exact aggregate MIME header boundary before derived writes", async () => {
    const allowed = createWorld();
    seedAddress(allowed.account, INBOX);
    await processInbound(
      new FakeEmail({
        to: INBOX,
        from: SENDER,
        raw: headerSizedEml(INBOX, INBOUND_MIME_LIMITS.maxHeadersSize),
      }),
      allowed.ports,
    );
    await consumeQueued(allowed);
    expect(allowed.account.accepted).toHaveLength(1);
    expect(allowed.account.policyFailures).toEqual([]);

    const exceeded = createWorld();
    seedAddress(exceeded.account, INBOX);
    await processInbound(
      new FakeEmail({
        to: INBOX,
        from: SENDER,
        raw: headerSizedEml(INBOX, INBOUND_MIME_LIMITS.maxHeadersSize + 1),
      }),
      exceeded.ports,
    );
    await consumeQueued(exceeded);
    await expectPolicyFailure(exceeded, "parse_failed");
  });

  it("enforces the exact MIME tree-depth boundary before derived writes", async () => {
    const allowed = createWorld();
    seedAddress(allowed.account, INBOX);
    await processInbound(
      new FakeEmail({
        to: INBOX,
        from: SENDER,
        raw: nestedMultipartEml(INBOX, INBOUND_MIME_LIMITS.maxNestingDepth),
      }),
      allowed.ports,
    );
    await consumeQueued(allowed);
    expect(allowed.account.accepted).toHaveLength(1);

    const exceeded = createWorld();
    seedAddress(exceeded.account, INBOX);
    await processInbound(
      new FakeEmail({
        to: INBOX,
        from: SENDER,
        raw: nestedMultipartEml(INBOX, INBOUND_MIME_LIMITS.maxNestingDepth + 1),
      }),
      exceeded.ports,
    );
    await consumeQueued(exceeded);
    await expectPolicyFailure(exceeded, "parse_failed");
  });

  it("rejects the PostalMime RFC822 depth marker at the configured boundary", async () => {
    const allowed = createWorld();
    seedAddress(allowed.account, INBOX);
    await processInbound(
      new FakeEmail({
        to: INBOX,
        from: SENDER,
        raw: nestedRfc822Eml(INBOX, INBOUND_MIME_LIMITS.maxRfc822NestingDepth),
      }),
      allowed.ports,
    );
    await consumeQueued(allowed);
    expect(allowed.account.accepted).toHaveLength(1);

    const exceeded = createWorld();
    seedAddress(exceeded.account, INBOX);
    await processInbound(
      new FakeEmail({
        to: INBOX,
        from: SENDER,
        raw: nestedRfc822Eml(INBOX, INBOUND_MIME_LIMITS.maxRfc822NestingDepth + 1),
      }),
      exceeded.ports,
    );
    await consumeQueued(exceeded);
    await expectPolicyFailure(exceeded, "rfc822_depth");
  });

  it("rejects a post-sanitizer body that exceeds the persisted message budget before attachment writes", async () => {
    const raw = relatedImageEml(INBOX);
    const allowed = createWorld();
    seedAddress(allowed.account, INBOX);
    allowed.htmlPolicy.setOutput("ok");
    await processInbound(new FakeEmail({ to: INBOX, from: SENDER, raw }), allowed.ports);
    await consumeQueued(allowed);
    expect(allowed.account.accepted).toHaveLength(1);
    expect(derivedObjectKeys(allowed)).toHaveLength(1);

    const exceeded = createWorld();
    seedAddress(exceeded.account, INBOX);
    exceeded.htmlPolicy.setOutput("x".repeat(MAX_PERSISTED_MESSAGE_BYTES + 1));
    await processInbound(new FakeEmail({ to: INBOX, from: SENDER, raw }), exceeded.ports);
    await consumeQueued(exceeded);
    await expectPolicyFailure(exceeded, "message_budget");
  });

  it("keeps derived R2 failures operational and retryable", async () => {
    const world = createWorld();
    seedAddress(world.account, INBOX);
    const raw = relatedImageEml(INBOX);
    await processInbound(new FakeEmail({ to: INBOX, from: SENDER, raw }), world.ports);
    world.archive.failNextStorePut();

    await expect(consumeQueued(world)).rejects.toMatchObject({ reason: "put_failed" });
    expect(world.account.accepted).toHaveLength(0);
    expect(derivedObjectKeys(world)).toHaveLength(0);
    expect(rawObjectKeys(world)).toHaveLength(1);

    await consumeQueued(world);
    expect(world.account.accepted).toHaveLength(1);
    expect(derivedObjectKeys(world)).toHaveLength(1);
  });

  it("converges after an interruption at every derived R2 put ordinal", async () => {
    const attachmentCount = 3;
    for (let failingOrdinal = 0; failingOrdinal < attachmentCount; failingOrdinal++) {
      const world = createWorld();
      seedAddress(world.account, INBOX);
      await processInbound(
        new FakeEmail({
          to: INBOX,
          from: SENDER,
          raw: attachmentCountEml(INBOX, attachmentCount),
        }),
        world.ports,
      );
      world.archive.failStorePutAtOrdinal(failingOrdinal);

      await expect(consumeQueued(world)).rejects.toMatchObject({ reason: "put_failed" });
      expect(world.account.accepted).toHaveLength(0);
      expect(derivedObjectKeys(world)).toHaveLength(failingOrdinal);

      await consumeQueued(world);
      expect(world.account.accepted).toHaveLength(1);
      expect(world.account.accepted[0]?.attachments).toHaveLength(attachmentCount);
      expect(new Set(derivedObjectKeys(world)).size).toBe(attachmentCount);
    }
  });

  it("preserves the first successful indexed representation across duplicate receipt work", async () => {
    const world = createWorld();
    seedAddress(world.account, INBOX);
    await processInbound(
      new FakeEmail({ to: INBOX, from: SENDER, raw: attachmentCountEml(INBOX, 3) }),
      world.ports,
    );
    await consumeQueued(world);
    const first = world.account.accepted[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    await consumeQueued(world);
    expect(world.account.accepted).toEqual([first]);
    expect(world.account.accepted[0]?.attachments).toHaveLength(3);
  });

  it("rejects advertised oversize without archiving or enqueueing", async () => {
    const world = createWorld();
    seedAddress(world.account, INBOX);
    const raw = plainHtmlEml(INBOX, "<p>Hi</p>");
    const email = new FakeEmail({
      to: INBOX,
      from: SENDER,
      raw,
      rawSize: DEFAULT_MAX_RAW_BYTES + 1,
    });
    const result = await processInbound(email, world.ports);

    expect(result).toEqual({ kind: "rejected", reason: "message too large" });
    expect(email.rejectReason).toBe("message too large");
    expect(world.archive.objects.size).toBe(0);
    expect(world.index.payloads).toHaveLength(0);
  });

  it("does not persist a second message for a duplicate digest+recipient", async () => {
    const world = createWorld();
    seedAddress(world.account, INBOX, FORWARD_DEST);
    const raw = plainHtmlEml(INBOX, "<p>Hi</p>");

    const first = new FakeEmail({ to: INBOX, from: SENDER, raw });
    await processInbound(first, world.ports);
    await consumeQueued(world);

    const second = new FakeEmail({ to: INBOX, from: SENDER, raw });
    await processInbound(second, world.ports);
    await consumeQueued(world);

    expect(world.account.accepted).toHaveLength(1);
    expect(first.forwards).toEqual([FORWARD_DEST]);
    expect(second.forwards).toEqual([]);
  });

  it("enforces the exact attachment-count boundary before derived writes", async () => {
    const allowed = createWorld();
    seedAddress(allowed.account, INBOX);
    await processInbound(
      new FakeEmail({
        to: INBOX,
        from: SENDER,
        raw: attachmentCountEml(INBOX, MAX_ATTACHMENTS),
      }),
      allowed.ports,
    );
    await consumeQueued(allowed);
    expect(allowed.account.accepted).toHaveLength(1);
    expect(allowed.account.accepted[0]?.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(derivedObjectKeys(allowed)).toHaveLength(MAX_ATTACHMENTS);

    const exceeded = createWorld();
    seedAddress(exceeded.account, INBOX);
    const accepted = await processInbound(
      new FakeEmail({
        to: INBOX,
        from: SENDER,
        raw: attachmentCountEml(INBOX, MAX_ATTACHMENTS + 1),
      }),
      exceeded.ports,
    );
    expect(accepted.kind).toBe("accepted");
    await consumeQueued(exceeded);
    await expectPolicyFailure(exceeded, "attachment_cap");
  });

  it("keeps missing raw and address lookup faults operational", async () => {
    const missingRaw = createWorld();
    seedAddress(missingRaw.account, INBOX);
    await processInbound(
      new FakeEmail({ to: INBOX, from: SENDER, raw: plainHtmlEml(INBOX, "<p>raw</p>") }),
      missingRaw.ports,
    );
    missingRaw.archive.objects.clear();
    await expect(consumeQueued(missingRaw)).rejects.toMatchObject({ reason: "raw_missing" });
    expect(missingRaw.account.accepted).toHaveLength(0);

    const missingAddress = createWorld();
    seedAddress(missingAddress.account, INBOX);
    await processInbound(
      new FakeEmail({ to: INBOX, from: SENDER, raw: plainHtmlEml(INBOX, "<p>address</p>") }),
      missingAddress.ports,
    );
    missingAddress.account.addresses.clear();
    await expect(consumeQueued(missingAddress)).rejects.toMatchObject({
      reason: "address_missing",
    });
    expect(missingAddress.account.accepted).toHaveLength(0);
  });

  it("persists inbound direction and raw threading headers", async () => {
    const world = createWorld();
    seedAddress(world.account, INBOX);

    await processInbound(
      new FakeEmail({ to: INBOX, from: SENDER, raw: threadedEml(INBOX) }),
      world.ports,
    );
    await consumeQueued(world);

    expect(world.account.accepted).toHaveLength(1);
    const message = world.account.accepted[0];
    expect(message).toBeDefined();
    if (message === undefined) return;
    expect(message.rfcMessageId).toBe("<child@example.com>");
    expect(message.inReplyToHeader).toBe("<parent@example.com>");
    expect(message.referencesHeader).toBe("<root@example.com> <parent@example.com>");
    expect((message.from ?? []).map((contact) => contact.address)).toEqual([SENDER]);
    expect((message.replyTo ?? []).map((contact) => contact.address)).toEqual([
      "replies@example.com",
    ]);
    expect((message.to ?? []).map((contact) => contact.address)).toEqual([INBOX]);
    expect((message.cc ?? []).map((contact) => contact.address)).toEqual(["cc@example.com"]);
  });
});

function createWorld() {
  const archive = new MemoryArchive();
  const index = new MemoryIndex();
  const account = new MailCapacityAccount();
  const htmlPolicy = new FakeMailHtmlPolicy();
  return {
    archive,
    index,
    account,
    htmlPolicy,
    ports: {
      ARCHIVE: archive,
      INDEX: index,
      ACCOUNT: account,
      nowIso: () => TEST_NOW_ISO,
    },
  };
}

type World = ReturnType<typeof createWorld>;

function seedAddress(
  account: MailCapacityAccount,
  address: string,
  destination: string | null = null,
): void {
  const normalized = parseMailboxAddress(address);
  if (normalized.kind === "invalid") {
    throw new Error("test fixture address is invalid");
  }
  const mailbox = {
    id: ADDRESS_ID,
    localPart: normalized.localPart,
    address: normalized.address,
    displayName: "Inbox",
    active: true,
    forwardingDestinationId: destination === null ? null : "dest-1",
    createdAt: TEST_NOW_ISO,
    updatedAt: TEST_NOW_ISO,
  } satisfies AccountAddress;
  if (destination === null) {
    account.seedAddress(mailbox);
    return;
  }
  account.seedAddress(mailbox, {
    id: "dest-1",
    cloudflareId: "cf-1",
    email: destination,
    verificationStatus: "verified",
    verifiedAt: TEST_NOW_ISO,
    createdAt: TEST_NOW_ISO,
    updatedAt: TEST_NOW_ISO,
  });
}

async function consumeQueued(world: World): Promise<void> {
  const queued = world.index.payloads.splice(0);
  if (queued.length === 0) {
    const remaining = [...world.account.receipts.keys()];
    for (const receiptId of remaining) {
      await Effect.runPromise(
        consumeIndexReceipt(
          receiptId,
          world.archive.asStore(),
          world.htmlPolicy,
          world.account.asIndexAccount(),
          TEST_NOW_ISO,
          CLAIM_UNTIL_ISO,
        ),
      );
    }
    return;
  }
  for (const work of queued) {
    await Effect.runPromise(
      consumeIndexReceipt(
        work.receiptId,
        world.archive.asStore(),
        world.htmlPolicy,
        world.account.asIndexAccount(),
        TEST_NOW_ISO,
        CLAIM_UNTIL_ISO,
      ),
    );
  }
}

type PolicyFailureReason =
  | "attachment_cap"
  | "message_budget"
  | "mime_budget"
  | "parse_failed"
  | "rfc822_depth"
  | "sanitize_failed";

async function expectPolicyFailure(world: World, reason: PolicyFailureReason): Promise<void> {
  expect(world.account.accepted).toEqual([]);
  expect(world.account.policyFailures.map((failure) => failure.reason)).toEqual([reason]);
  expect(derivedObjectKeys(world)).toHaveLength(0);
  expect(rawObjectKeys(world)).toHaveLength(1);
}

function derivedObjectKeys(world: World): ReadonlyArray<string> {
  return [...world.archive.objects.keys()].filter((key) => key.startsWith("attachments/"));
}

function rawObjectKeys(world: World): ReadonlyArray<string> {
  return [...world.archive.objects.keys()].filter((key) => key.startsWith("raw/"));
}

function firstRawKey(world: World): string {
  const key = rawObjectKeys(world)[0];
  if (key === undefined) {
    throw new Error("expected raw archive object");
  }
  return key;
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
