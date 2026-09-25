/// <reference types="@cloudflare/vitest-plugin/types" />

import {
  NormalizedRfcMessageId,
  OPERATOR_POLICY,
  parseExternalMailAddress,
  parseMailDomain,
  SubmissionRequestId,
  type MailDomain,
} from "@umail/api-contract";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ClaimJobResult, CompleteAttemptResult } from "../../src/account/domain.ts";
import { accountStore, approvalMaterial, failureOf, taggedName } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";
const CLAIM_EXPIRES = "2026-01-01T00:15:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");
const REQUEST_A = "ccccccca-cccc-4ccc-8ccc-cccccccccccc";
const PROVIDER_ID = Schema.decodeSync(NormalizedRfcMessageId)("<provider-1@cf.example>");

type Store = DurableObjectStub<AccountStoreTestHost>;

describe("account-store threading", () => {
  it.effect("joins a late parent into the child's thread and keeps the child's old thread id", () =>
    Effect.gen(function* () {
      const store = accountStore("threading-late-parent");
      const child = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("child", "<child@example.com>", "<parent@example.com>", { at: second(1) }),
        ),
      );
      expect(child.threadId).toBe("child");
      expect(yield* thread(store, "child")).toEqual({
        threadId: "child",
        members: [["child", null]],
      });

      const parent = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("parent", "<parent@example.com>", null, { at: second(0) }),
        ),
      );
      expect(parent.threadId).toBe("parent");
      const joined = {
        threadId: "parent",
        members: [
          ["parent", null],
          ["child", "parent"],
        ],
      };
      expect(yield* thread(store, child.threadId)).toEqual(joined);
      expect(yield* thread(store, "parent")).toEqual(joined);
    }),
  );

  it.effect("puts children of a missing parent into one thread", () =>
    Effect.gen(function* () {
      const store = accountStore("threading-missing-parent");
      const childA = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("child-a", "<child-a@example.com>", "<parent@example.com>", { at: second(1) }),
        ),
      );
      const childB = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("child-b", "<child-b@example.com>", "<parent@example.com>", { at: second(2) }),
        ),
      );
      expect(childB.threadId).toBe(childA.threadId);
      expect(yield* thread(store, "child-b")).toEqual({
        threadId: "child-a",
        members: [
          ["child-a", null],
          ["child-b", null],
        ],
      });

      yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("parent", "<parent@example.com>", null, { at: second(0) }),
        ),
      );
      expect(yield* thread(store, "child-b")).toEqual({
        threadId: "parent",
        members: [
          ["parent", null],
          ["child-a", "parent"],
          ["child-b", "parent"],
        ],
      });
    }),
  );

  it.effect("threads a reply whose direct parent is missing through an older reference (F6)", () =>
    Effect.gen(function* () {
      const store = accountStore("threading-f6");
      yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(mail("a", "<a@example.com>", null, { at: second(0) })),
      );
      const c = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("c", "<c@example.com>", "<b@example.com>", {
            at: second(2),
            references: "<a@example.com> <b@example.com>",
          }),
        ),
      );
      expect(c.threadId).toBe("a");
      expect(yield* thread(store, "c")).toEqual({
        threadId: "a",
        members: [
          ["a", null],
          ["c", null],
        ],
      });

      yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("b", "<b@example.com>", "<a@example.com>", { at: second(1) }),
        ),
      );
      expect(yield* thread(store, "a")).toEqual({
        threadId: "a",
        members: [
          ["a", null],
          ["b", "a"],
          ["c", "b"],
        ],
      });
    }),
  );

  it.effect("merges two threads bridged by a later message and keeps both old ids resolving", () =>
    Effect.gen(function* () {
      const store = accountStore("threading-merge");
      const a = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(mail("a", "<a@example.com>", null, { at: second(0) })),
      );
      const c = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("c", "<c@example.com>", "<b@example.com>", { at: second(2), references: null }),
        ),
      );
      expect(c.threadId).not.toBe(a.threadId);

      const b = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("b", "<b@example.com>", "<a@example.com>", { at: second(1), references: null }),
        ),
      );
      expect(b.threadId).toBe(a.threadId);
      const merged = {
        threadId: "a",
        members: [
          ["a", null],
          ["b", "a"],
          ["c", "b"],
        ],
      };
      expect(yield* thread(store, a.threadId)).toEqual(merged);
      expect(yield* thread(store, c.threadId)).toEqual(merged);
    }),
  );

  it.effect("puts messages that share a Message-ID into one thread", () =>
    Effect.gen(function* () {
      const store = accountStore("threading-shared-message-id");
      const outbound = yield* Effect.promise(() =>
        store.acceptOutbound(mail("out-1", "<out-1@cf.example>", null, { at: second(0) })),
      );
      const copy = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("in-copy", "<out-1@cf.example>", null, { at: second(1) }),
        ),
      );
      expect(copy.threadId).toBe(outbound.threadId);
      expect((yield* thread(store, "in-copy")).members.map(([id]) => id)).toEqual([
        "out-1",
        "in-copy",
      ]);
    }),
  );

  it.effect("joins a reply that arrives before the send completes to the sent thread", () =>
    Effect.gen(function* () {
      const store = accountStore("threading-early-reply");
      const mailbox = yield* requireAddress(store, "inbox");
      const submitted = yield* Effect.promise(() =>
        store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_A)),
      );
      const sentId = submitted.job.messageId;
      expect(submitted.job.threadId).toBe(sentId);
      const claimed = yield* Effect.promise<ClaimJobResult>(() =>
        store.claimJob({
          jobId: submitted.job.jobId,
          nowIso: NOW,
          claimExpiresAt: CLAIM_EXPIRES,
          policy: OPERATOR_POLICY,
        }),
      );
      if (claimed.kind !== "claimed") {
        throw new Error("expected claim");
      }
      const early = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("early-reply", "<early@example.com>", PROVIDER_ID, {
            at: second(1),
            mailboxId: mailbox.id,
          }),
        ),
      );
      expect(early.threadId).toBe("early-reply");
      expect((yield* thread(store, sentId)).members).toEqual([[sentId, null]]);

      const completed = yield* Effect.promise<CompleteAttemptResult>(() =>
        store.completeAttempt({
          jobId: submitted.job.jobId,
          attemptId: claimed.attemptId,
          nowIso: LATER,
          outcome: { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: PROVIDER_ID },
        }),
      );
      expect(completed).toMatchObject({
        kind: "applied",
        job: { state: "accepted", threadId: sentId },
      });
      const joined = {
        threadId: sentId,
        members: [
          [sentId, null],
          ["early-reply", sentId],
        ],
      };
      expect(yield* thread(store, sentId)).toEqual(joined);
      expect(yield* thread(store, early.threadId)).toEqual(joined);
    }),
  );

  it.effect("rejects a duplicate message id and leaves the stored message untouched", () =>
    Effect.gen(function* () {
      const store = accountStore("threading-duplicate-id");
      yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(mail("same", "<first@example.com>", null)),
      );
      // An indexed receipt makes a repeated inbound accept a no-op, so the outbound path hits the id.
      const failure = yield* failureOf(store, (host) =>
        host.acceptOutbound(
          mail("same", "<second@example.com>", "<missing@example.com>", { at: second(1) }),
        ),
      );
      expect(taggedName(failure)).toBe("MessageConflictError");

      const page = yield* Effect.promise(() =>
        store.listThreadMessageSummaries("same", { mailboxScope: "all" }),
      );
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: "same",
        rfcMessageId: "<first@example.com>",
        inReplyToRfcMessageId: null,
        references: [],
      });
      const probe = yield* Effect.promise(() =>
        store.acceptInboundWithReceipt(
          mail("probe", "<probe@example.com>", "<missing@example.com>", { at: second(2) }),
        ),
      );
      expect(probe.threadId).toBe("probe");
    }),
  );

  it.effect("answers an unknown thread id with ThreadNotFoundError", () =>
    Effect.gen(function* () {
      const store = accountStore("threading-unknown-id");
      const failure = yield* failureOf(store, (host) =>
        host.listThreadMessageSummaries("no-such-message", { mailboxScope: "all" }),
      );
      expect(taggedName(failure)).toBe("ThreadNotFoundError");
    }),
  );
});

// The thread a message id resolves to, with each live member's id and parent message id.
const thread = Effect.fn("thread")(function* (store: Store, messageId: string) {
  const page = yield* Effect.promise(() =>
    store.listThreadMessageSummaries(messageId, { mailboxScope: "all" }),
  );
  return {
    threadId: page.threadId,
    members: page.items.map((item) => [item.id, item.parentMessageId]),
  };
});

function operatorSubmit(mailboxId: string, requestId: string) {
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "operator" as const, clientId: "cli", label: "AgentMail CLI" },
    policy: OPERATOR_POLICY,
    mailboxId,
    subject: "Direct",
    textBody: "body",
    htmlBody: null,
    hasRemoteImages: false,
    to: [{ address: requireExternal("recipient@example.com"), displayName: null }],
    cc: [],
    inReplyToHeader: null,
    referencesHeader: null,
    nowIso: NOW,
    approval: approvalMaterial(NOW),
  };
}

const requireAddress = Effect.fn("requireAddress")(function* (store: Store, localPart: string) {
  const created = yield* Effect.promise(() =>
    store.createAddress(localPart, DOMAIN, localPart, NOW),
  );
  if (created === null) {
    throw new Error(`expected address ${localPart}`);
  }
  return created;
});

function requireMailDomain(raw: string): MailDomain {
  const parsed = parseMailDomain(raw);
  if (parsed.kind !== "ok") {
    throw new Error("expected mail domain");
  }
  return parsed.domain;
}

function requireExternal(raw: string) {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error("expected external address");
  }
  return parsed.address;
}

function second(offset: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, offset)));
}

// `nowIso` follows `occurredAt`, so the oldest message is also the oldest thread and wins a merge.
function mail(
  messageId: string,
  rfcMessageId: string | null,
  inReplyToHeader: string | null,
  options: { at?: string; references?: string | null; mailboxId?: string } = {},
) {
  const occurredAt = options.at ?? NOW;
  return {
    messageId,
    mailboxId: options.mailboxId ?? "mbox-1",
    rfcMessageId,
    inReplyToHeader,
    referencesHeader: options.references === undefined ? inReplyToHeader : options.references,
    occurredAt,
    nowIso: occurredAt,
    parsedDate: null,
  };
}
