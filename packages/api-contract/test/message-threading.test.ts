import * as Contract from "@umail/api-contract";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  comparisonKey,
  dedupeMailContacts,
  isOwnRegisteredIdentity,
  MailContact,
  parseExternalMailAddress,
} from "../src/mail-contact.ts";
import { MailboxAddress, parseMailDomain, parseMailboxAddress } from "../src/mailbox-address.ts";
import {
  buildOutboundReferences,
  joinRfcMessageIds,
  normalizeRfcMessageId,
  normalizeRfcMessageIdList,
  pruneReferences,
  REFERENCES_BYTE_LIMIT,
  type NormalizedRfcMessageId,
} from "../src/message-threading.ts";
import { MailThreadPage, SubmitMessagePayload } from "../src/api-spec.ts";

const MANAGED = requireMailDomain("umail.example.com");
const INBOX = requireMailbox("inbox@umail.example.com");

describe("external mail addresses", () => {
  it("preserves plus-addresses and mixed-case local parts while lowercasing the domain", () => {
    expect(parseExternalMailAddress(" User+Tag@Example.COM ")).toEqual({
      kind: "ok",
      localPart: "User+Tag",
      domain: "example.com",
      address: "User+Tag@example.com",
      comparisonKey: "User+Tag@example.com",
    });
  });

  it("keeps display names on contacts and dedupes by comparison key in first-seen order", () => {
    const first = requireContact("User+Tag@Example.COM", "Ada");
    const duplicate = requireContact("User+Tag@example.com", "Other");
    const other = requireContact("second@example.com", null);
    expect(dedupeMailContacts([first, duplicate, other])).toEqual([first, other]);
    expect(comparisonKey(first.address)).toBe("User+Tag@example.com");
  });

  it("excludes registered managed-domain identities without forcing plus-addresses through MailboxAddress", () => {
    const registered = new Set<MailboxAddress>([INBOX]);
    const mixedCaseOwn = requireExternal("Inbox@UMail.Example.COM");
    const plusOnManaged = requireExternal("inbox+tag@umail.example.com");
    const outsider = requireExternal("Inbox@example.com");

    expect(isOwnRegisteredIdentity(mixedCaseOwn, MANAGED, registered)).toBe(true);
    expect(isOwnRegisteredIdentity(plusOnManaged, MANAGED, registered)).toBe(false);
    expect(isOwnRegisteredIdentity(outsider, MANAGED, registered)).toBe(false);
    expect(parseMailboxAddress("inbox+tag@umail.example.com")).toEqual({ kind: "invalid" });
  });

  it.each(["", "local", "@example.com", "local@", "a b@example.com", "local@exam ple.com"])(
    "rejects invalid external address %s",
    (raw) => {
      expect(parseExternalMailAddress(raw)).toEqual({ kind: "invalid" });
    },
  );
});

describe("RFC message-id normalization", () => {
  it("unfolds folded headers and keeps first-seen order while dropping duplicates", () => {
    expect(
      normalizeRfcMessageIdList(
        "<first@example.com>\r\n\t<second@example.com> <first@example.com>",
      ),
    ).toEqual(["<first@example.com>", "<second@example.com>"]);
  });

  it("wraps a bare token and rejects malformed or control-bearing tokens", () => {
    expect(normalizeRfcMessageId(" mid@example.com ")).toBe("<mid@example.com>");
    expect(normalizeRfcMessageId("<ok@example.com> <extra@example.com>")).toBeNull();
    expect(normalizeRfcMessageId("not-an-id")).toBeNull();
    expect(normalizeRfcMessageId("<bad example.com>")).toBeNull();
    expect(normalizeRfcMessageId("<ok@example.com>\u0007")).toBeNull();
    expect(normalizeRfcMessageIdList("<ok@example.com> <<<broken@example.com>")).toEqual([
      "<ok@example.com>",
    ]);
  });
});

describe("outbound References construction", () => {
  it("appends the parent id and prunes oldest tokens to stay within 2048 UTF-8 bytes", () => {
    const parent = requireRfcId(`<${"p".repeat(20)}@example.com>`);
    const oldest = requireRfcId(`<${"o".repeat(80)}@example.com>`);
    const middle = requireRfcId(`<${"m".repeat(80)}@example.com>`);
    const packed = Array.from({ length: 40 }, (_, index) =>
      requireRfcId(`<${"x".repeat(40)}${String(index)}@example.com>`),
    );
    const pruned = buildOutboundReferences(parent, [oldest, middle, ...packed]);
    expect(pruned.at(-1)).toBe(parent);
    expect(utf8ByteLength(joinRfcMessageIds(pruned))).toBeLessThanOrEqual(REFERENCES_BYTE_LIMIT);
    expect(pruned.includes(oldest)).toBe(false);
  });

  it("keeps the parent when it is the only token that fits", () => {
    const parent = requireRfcId("<parent@example.com>");
    const oversized = requireRfcId(`<${"y".repeat(2040)}@example.com>`);
    const pruned = pruneReferences([oversized, parent], REFERENCES_BYTE_LIMIT);
    expect(pruned).toEqual([parent]);
  });
});

describe("compose and reply contract", () => {
  const contact = { address: "user+tag@example.com", displayName: "Ada" };
  const requestId = "11111111-1111-4111-8111-111111111111";

  it("accepts compose with To and optional CC and at least one body", () => {
    const decoded = Schema.decodeResult(SubmitMessagePayload)({
      intent: "compose",
      requestId,
      fromAddressId: "addr-1",
      to: [contact],
      cc: [{ address: "cc@example.com" }],
      subject: "Hello",
      text: "body",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success).toMatchObject({ intent: "compose", cc: [{ displayName: null }] });
  });

  it("accepts reply with a mode and no client recipients", () => {
    const decoded = Schema.decodeResult(SubmitMessagePayload)({
      intent: "reply",
      requestId,
      fromAddressId: "addr-1",
      replyToMessageId: "in_1",
      replyMode: "reply-all",
      subject: "Re: Hello",
      html: "<p>body</p>",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success.intent).toBe("reply");
    expect("to" in decoded.success).toBe(false);
  });

  it("rejects compose without To, reply without a mode, and payloads with no body", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(SubmitMessagePayload)({
          intent: "compose",
          fromAddressId: "addr-1",
          to: [],
          subject: "Hello",
          text: "body",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(SubmitMessagePayload)({
          intent: "reply",
          fromAddressId: "addr-1",
          replyToMessageId: "in_1",
          subject: "Hello",
          text: "body",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeResult(SubmitMessagePayload)({
          intent: "compose",
          requestId,
          fromAddressId: "addr-1",
          to: [contact],
          subject: "Hello",
        }),
      ),
    ).toBe(true);
  });

  it("rejects the deleted flat send and page shapes", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(SubmitMessagePayload)({
          fromAddressId: "addr-1",
          to: ["user@example.com"],
          subject: "Hello",
          text: "body",
          inReplyTo: "in_1",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(MailThreadPage)({
          items: [{ direction: "inbound", id: "in_1" }],
          nextCursor: null,
        }),
      ),
    ).toBe(true);
    expect("InboundMessageSummary" in Contract).toBe(false);
    expect("ComposeMessagePayload" in Contract).toBe(false);
  });
});

function requireMailDomain(raw: string) {
  const parsed = parseMailDomain(raw);
  expect(parsed.kind).toBe("ok");
  if (parsed.kind !== "ok") {
    throw new Error("expected a mail domain");
  }
  return parsed.domain;
}

function requireMailbox(raw: string) {
  const parsed = parseMailboxAddress(raw);
  expect(parsed.kind).toBe("ok");
  if (parsed.kind !== "ok") {
    throw new Error("expected a mailbox address");
  }
  return parsed.address;
}

function requireExternal(raw: string) {
  const parsed = parseExternalMailAddress(raw);
  expect(parsed.kind).toBe("ok");
  if (parsed.kind !== "ok") {
    throw new Error("expected an external address");
  }
  return parsed.address;
}

function requireContact(raw: string, displayName: string | null) {
  return new MailContact({
    address: requireExternal(raw),
    displayName,
  });
}

function requireRfcId(raw: string): NormalizedRfcMessageId {
  const normalized = normalizeRfcMessageId(raw);
  expect(normalized).not.toBeNull();
  if (normalized === null) {
    throw new Error("expected an RFC message id");
  }
  return normalized;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
