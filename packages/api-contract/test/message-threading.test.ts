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
  deriveThreadRoot,
  internalThreadId,
  joinRfcMessageIds,
  normalizeRfcMessageId,
  normalizeRfcMessageIdList,
  parseThreadId,
  pruneReferences,
  REFERENCES_BYTE_LIMIT,
  resolveDirectParentRfcId,
  rfcThreadId,
  type NormalizedRfcMessageId,
  type RfcIdIndex,
} from "../src/message-threading.ts";
import {
  ComposeMessagePayload,
  MailThreadPage,
  ReplyMessagePayload,
  SendMessagePayload,
} from "../src/api-spec.ts";

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

describe("thread ids", () => {
  it("round-trips RFC ids that contain reserved URL characters", () => {
    const messageId = requireRfcId("<a/b?c%d[e]f@example.com>");
    const threadId = rfcThreadId(messageId);
    expect(threadId.startsWith("rfc:")).toBe(true);
    expect(threadId).not.toContain("/");
    expect(threadId).not.toContain("?");
    expect(threadId).not.toContain("%");
    expect(threadId).not.toContain("[");
    expect(threadId).not.toContain("]");
    expect(parseThreadId(threadId)).toEqual({
      kind: "rfc",
      threadId,
      messageId,
    });
  });

  it("round-trips an internal UUID thread id", () => {
    const threadId = internalThreadId("550e8400-e29b-41d4-a716-446655440000");
    expect(threadId).toBe("internal:550e8400-e29b-41d4-a716-446655440000");
    expect(parseThreadId(threadId ?? "")).toEqual({
      kind: "internal",
      threadId,
      uuid: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("round-trips an opaque node thread handle and rejects RFC-derived ids", () => {
    const handle = Contract.nodeThreadHandle("550e8400-e29b-41d4-a716-446655440000");
    expect(handle).toBe("node:550e8400-e29b-41d4-a716-446655440000");
    expect(Contract.parseThreadHandle(handle ?? "")).toEqual({
      kind: "node",
      handle,
      nodeId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(Contract.parseThreadHandle("rfc:abc")).toEqual({ kind: "invalid" });
    expect(Contract.parseThreadHandle("internal:550e8400-e29b-41d4-a716-446655440000")).toEqual({
      kind: "invalid",
    });
  });
});

describe("parent and root selection", () => {
  const parent = requireRfcId("<parent@example.com>");
  const older = requireRfcId("<older@example.com>");
  const newer = requireRfcId("<newer@example.com>");
  const own = requireRfcId("<own@example.com>");
  const index: RfcIdIndex = {
    unique: new Set([parent, older, newer]),
    ambiguous: new Set([own]),
  };

  it("prefers a unique In-Reply-To over newer references", () => {
    expect(resolveDirectParentRfcId(parent, [newer, older], index)).toBe(parent);
  });

  it("walks References newest-first when In-Reply-To is missing or ambiguous", () => {
    expect(resolveDirectParentRfcId(null, [newer, older], index)).toBe(newer);
    expect(resolveDirectParentRfcId(own, [newer, older], index)).toBe(newer);
  });

  it("never selects an ambiguous own identifier as a parent", () => {
    expect(
      resolveDirectParentRfcId(own, [own], {
        unique: new Set(),
        ambiguous: new Set([own]),
      }),
    ).toBeNull();
  });

  it("derives a root from the oldest reference, then parent, then own id, then internal UUID", () => {
    expect(
      deriveThreadRoot([older, newer], parent, own, "550e8400-e29b-41d4-a716-446655440000"),
    ).toBe(rfcThreadId(older));
    expect(deriveThreadRoot([], parent, own, "550e8400-e29b-41d4-a716-446655440000")).toBe(
      rfcThreadId(parent),
    );
    expect(deriveThreadRoot([], null, own, "550e8400-e29b-41d4-a716-446655440000")).toBe(
      rfcThreadId(own),
    );
    expect(deriveThreadRoot([], null, null, "550e8400-e29b-41d4-a716-446655440000")).toBe(
      "internal:550e8400-e29b-41d4-a716-446655440000",
    );
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

  it("accepts compose with To and optional CC and at least one body", () => {
    const decoded = Schema.decodeResult(SendMessagePayload)({
      intent: "compose",
      fromAddressId: "addr-1",
      to: [contact],
      cc: [{ address: "cc@example.com", displayName: null }],
      subject: "Hello",
      text: "body",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) return;
    expect(decoded.success.intent).toBe("compose");
  });

  it("accepts reply with a mode and no client recipients", () => {
    const decoded = Schema.decodeResult(SendMessagePayload)({
      intent: "reply",
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
        Schema.decodeUnknownResult(SendMessagePayload)({
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
        Schema.decodeUnknownResult(SendMessagePayload)({
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
        Schema.decodeResult(SendMessagePayload)({
          intent: "compose",
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
        Schema.decodeUnknownResult(SendMessagePayload)({
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
    expect(ComposeMessagePayload).toBeDefined();
    expect(ReplyMessagePayload).toBeDefined();
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
