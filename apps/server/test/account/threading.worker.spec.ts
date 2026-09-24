/// <reference types="@cloudflare/vitest-plugin/types" />

import {
  NormalizedRfcMessageId,
  parseExternalMailAddress,
  parseMailDomain,
  SubmissionRequestId,
  type MailDomain,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

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
  it("joins a late parent into the child's thread and keeps the child's old thread id", async () => {
    const store = accountStore("threading-late-parent");
    const child = await store.acceptInboundWithReceipt(
      mail("child", "<child@example.com>", "<parent@example.com>", { at: second(1) }),
    );
    expect(child.threadId).toBe("child");
    expect(await thread(store, "child")).toEqual({
      threadId: "child",
      members: [["child", null]],
    });

    const parent = await store.acceptInboundWithReceipt(
      mail("parent", "<parent@example.com>", null, { at: second(0) }),
    );
    expect(parent.threadId).toBe("parent");
    const joined = {
      threadId: "parent",
      members: [
        ["parent", null],
        ["child", "parent"],
      ],
    };
    expect(await thread(store, child.threadId)).toEqual(joined);
    expect(await thread(store, "parent")).toEqual(joined);
  });

  it("puts children of a missing parent into one thread", async () => {
    const store = accountStore("threading-missing-parent");
    const childA = await store.acceptInboundWithReceipt(
      mail("child-a", "<child-a@example.com>", "<parent@example.com>", { at: second(1) }),
    );
    const childB = await store.acceptInboundWithReceipt(
      mail("child-b", "<child-b@example.com>", "<parent@example.com>", { at: second(2) }),
    );
    expect(childB.threadId).toBe(childA.threadId);
    expect(await thread(store, "child-b")).toEqual({
      threadId: "child-a",
      members: [
        ["child-a", null],
        ["child-b", null],
      ],
    });

    await store.acceptInboundWithReceipt(
      mail("parent", "<parent@example.com>", null, { at: second(0) }),
    );
    expect(await thread(store, "child-b")).toEqual({
      threadId: "parent",
      members: [
        ["parent", null],
        ["child-a", "parent"],
        ["child-b", "parent"],
      ],
    });
  });

  it("threads a reply whose direct parent is missing through an older reference (F6)", async () => {
    const store = accountStore("threading-f6");
    await store.acceptInboundWithReceipt(mail("a", "<a@example.com>", null, { at: second(0) }));
    const c = await store.acceptInboundWithReceipt(
      mail("c", "<c@example.com>", "<b@example.com>", {
        at: second(2),
        references: "<a@example.com> <b@example.com>",
      }),
    );
    expect(c.threadId).toBe("a");
    expect(await thread(store, "c")).toEqual({
      threadId: "a",
      members: [
        ["a", null],
        ["c", null],
      ],
    });

    await store.acceptInboundWithReceipt(
      mail("b", "<b@example.com>", "<a@example.com>", { at: second(1) }),
    );
    expect(await thread(store, "a")).toEqual({
      threadId: "a",
      members: [
        ["a", null],
        ["b", "a"],
        ["c", "b"],
      ],
    });
  });

  it("merges two threads bridged by a later message and keeps both old ids resolving", async () => {
    const store = accountStore("threading-merge");
    const a = await store.acceptInboundWithReceipt(
      mail("a", "<a@example.com>", null, { at: second(0) }),
    );
    const c = await store.acceptInboundWithReceipt(
      mail("c", "<c@example.com>", "<b@example.com>", { at: second(2), references: null }),
    );
    expect(c.threadId).not.toBe(a.threadId);

    const b = await store.acceptInboundWithReceipt(
      mail("b", "<b@example.com>", "<a@example.com>", { at: second(1), references: null }),
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
    expect(await thread(store, a.threadId)).toEqual(merged);
    expect(await thread(store, c.threadId)).toEqual(merged);
  });

  it("puts messages that share a Message-ID into one thread", async () => {
    const store = accountStore("threading-shared-message-id");
    const outbound = await store.acceptOutbound(
      mail("out-1", "<out-1@cf.example>", null, { at: second(0) }),
    );
    const copy = await store.acceptInboundWithReceipt(
      mail("in-copy", "<out-1@cf.example>", null, { at: second(1) }),
    );
    expect(copy.threadId).toBe(outbound.threadId);
    expect((await thread(store, "in-copy")).members.map(([id]) => id)).toEqual([
      "out-1",
      "in-copy",
    ]);
  });

  it("joins a reply that arrives before the send completes to the sent thread", async () => {
    const store = accountStore("threading-early-reply");
    const mailbox = await requireAddress(store, "inbox");
    const submitted = await store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_A));
    const sentId = submitted.job.messageId;
    expect(submitted.job.threadHandle).toBe(sentId);
    const claimed = await store.claimDispatch({
      jobId: submitted.job.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
    });
    if (claimed.kind !== "claimed") {
      throw new Error("expected claim");
    }
    const early = await store.acceptInboundWithReceipt(
      mail("early-reply", "<early@example.com>", PROVIDER_ID, {
        at: second(1),
        mailboxId: mailbox.id,
      }),
    );
    expect(early.threadId).toBe("early-reply");
    expect((await thread(store, sentId)).members).toEqual([[sentId, null]]);

    const completed = await store.completeAttempt({
      jobId: submitted.job.jobId,
      attemptId: claimed.attemptId,
      nowIso: LATER,
      outcome: { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: PROVIDER_ID },
    });
    expect(completed).toMatchObject({
      kind: "applied",
      job: { state: "accepted", threadHandle: sentId },
    });
    const joined = {
      threadId: sentId,
      members: [
        [sentId, null],
        ["early-reply", sentId],
      ],
    };
    expect(await thread(store, sentId)).toEqual(joined);
    expect(await thread(store, early.threadId)).toEqual(joined);
  });

  it("rejects a duplicate message id and leaves the stored message untouched", async () => {
    const store = accountStore("threading-duplicate-id");
    await store.acceptInboundWithReceipt(mail("same", "<first@example.com>", null));
    // An indexed receipt makes a repeated inbound accept a no-op, so the outbound path hits the id.
    const failure = await failureOf(store, (host) =>
      host.acceptOutbound(
        mail("same", "<second@example.com>", "<missing@example.com>", { at: second(1) }),
      ),
    );
    expect(taggedName(failure)).toBe("MessageConflictError");

    const page = await store.listThreadMessageSummaries("same", { mailboxScope: "all" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "same",
      rfcMessageId: "<first@example.com>",
      inReplyToRfcMessageId: null,
      references: [],
    });
    const probe = await store.acceptInboundWithReceipt(
      mail("probe", "<probe@example.com>", "<missing@example.com>", { at: second(2) }),
    );
    expect(probe.threadId).toBe("probe");
  });

  it("answers an unknown thread id with ThreadHandleError", async () => {
    const store = accountStore("threading-unknown-id");
    const failure = await failureOf(store, (host) =>
      host.listThreadMessageSummaries("no-such-message", { mailboxScope: "all" }),
    );
    expect(taggedName(failure)).toBe("ThreadHandleError");
  });
});

// The thread a message id resolves to, with each live member's id and parent message id.
async function thread(store: Store, messageId: string) {
  const page = await store.listThreadMessageSummaries(messageId, { mailboxScope: "all" });
  return {
    threadId: page.threadHandle,
    members: page.items.map((item) => [item.id, item.parentMessageId]),
  };
}

function operatorSubmit(mailboxId: string, requestId: string) {
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "operator" as const, clientId: "cli", label: "AgentMail CLI" },
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

async function requireAddress(store: Store, localPart: string) {
  const created = await store.createAddress(localPart, DOMAIN, localPart, NOW);
  if (created === null) {
    throw new Error(`expected address ${localPart}`);
  }
  return created;
}

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
  return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
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
