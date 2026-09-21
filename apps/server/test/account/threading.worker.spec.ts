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

import { conversationIsEligible } from "../../src/account/threading.ts";
import { accountStore, taggedName } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";
const CLAIM_EXPIRES = "2026-01-01T00:15:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");
const REQUEST_A = "ccccccca-cccc-4ccc-8ccc-cccccccccccc";
const PROVIDER_ID = Schema.decodeSync(NormalizedRfcMessageId)("<provider-1@cf.example>");

describe("account-store threading commands", () => {
  it("repairs a missing parent onto a stable child handle without rewriting descendants", async () => {
    const store = accountStore("threading-missing-parent");
    const child = await store.acceptInboundWithReceipt(
      mail("child", "<child@example.com>", "<parent@example.com>", "2026-01-01T00:00:01.000Z"),
    );
    expect(child.parentNodeId).not.toBeNull();
    expect(child.threadHandle.startsWith("node:")).toBe(true);
    const before = await store.resolveConversation(child.threadHandle);
    expect(before.messages.map((message) => message.id)).toEqual(["child"]);

    const parent = await store.acceptInboundWithReceipt(
      mail("parent", "<parent@example.com>", null, "2026-01-01T00:00:00.000Z"),
    );
    expect(parent.nodeId).toBe(child.parentNodeId);
    expect(parent.claimedRfcMessageId).toBe("<parent@example.com>");
    const after = await store.resolveConversation(child.threadHandle);
    expect(after.nodeId).toBe(child.nodeId);
    expect(after.messages.map((message) => message.id)).toEqual(["parent", "child"]);
    expect(after.messages.find((message) => message.id === "child")?.parentNodeId).toBe(
      parent.nodeId,
    );
  });

  it("completes the parent when the child is already in the same component", async () => {
    const store = accountStore("threading-same-component");
    const child = await store.acceptInboundWithReceipt(
      mail("child", "<child@example.com>", "<parent@example.com>"),
    );
    const parent = await store.acceptInboundWithReceipt(
      mail("parent", "<parent@example.com>", null),
    );
    const conversation = await store.resolveConversation(child.threadHandle);
    expect(conversation.componentRootId).toBe(
      (await store.resolveConversation(parent.threadHandle)).componentRootId,
    );
    expect(conversation.messages.find((message) => message.id === "child")?.parentNodeId).toBe(
      parent.nodeId,
    );
  });

  it("keeps a later duplicate of the same Message-ID out of the claimed component", async () => {
    const store = accountStore("threading-duplicate-last");
    const first = await store.acceptInboundWithReceipt(mail("first", "<dup@example.com>", null));
    const second = await store.acceptInboundWithReceipt(
      mail("second", "<dup@example.com>", null, "2026-01-01T00:00:01.000Z"),
    );
    expect(second.claimedRfcMessageId).toBeNull();
    expect(second.nodeId).not.toBe(first.nodeId);
    expect((await store.resolveConversation(first.threadHandle)).messages.map((m) => m.id)).toEqual(
      ["first"],
    );
    expect(
      (await store.resolveConversation(second.threadHandle)).messages.map((m) => m.id),
    ).toEqual(["second"]);
    const lookup = await store.inspectRfcLookup("<dup@example.com>");
    expect(lookup).toEqual({
      rfcMessageId: "<dup@example.com>",
      nodeId: first.nodeId,
      claimantNodeId: first.nodeId,
    });
  });

  it("does not coalesce an inbound copy onto an outbound Message-ID claim", async () => {
    const store = accountStore("threading-no-coalesce");
    const outbound = await store.acceptOutbound(mail("out-1", "<out-1@cf.example>", null));
    const inbound = await store.acceptInboundWithReceipt(
      mail("in-copy", "<out-1@cf.example>", null, "2026-01-01T00:00:01.000Z"),
    );
    expect(inbound.nodeId).not.toBe(outbound.nodeId);
    expect(
      (await store.resolveConversation(outbound.threadHandle)).messages.map(
        (message) => message.id,
      ),
    ).toEqual(["out-1"]);
    expect(
      (await store.resolveConversation(inbound.threadHandle)).messages.map((message) => message.id),
    ).toEqual(["in-copy"]);
  });

  it("ignores a cycling parent edge and retains both messages in the component", async () => {
    const store = accountStore("threading-cycle");
    const first = await store.acceptInboundWithReceipt(
      mail("a", "<a@example.com>", "<b@example.com>"),
    );
    const second = await store.acceptInboundWithReceipt(
      mail("b", "<b@example.com>", "<a@example.com>", "2026-01-01T00:00:01.000Z"),
    );
    expect(second.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["parent_cycle"]);
    expect(second.parentNodeId).toBeNull();
    const conversation = await store.resolveConversation(first.threadHandle);
    expect(conversation.messages.map((message) => message.id).sort()).toEqual(["a", "b"]);
  });

  it("joins concurrent descendants when the shared parent later arrives", async () => {
    const store = accountStore("threading-concurrent");
    const childA = await store.acceptInboundWithReceipt(
      mail("child-a", "<child-a@example.com>", "<parent@example.com>"),
    );
    const childB = await store.acceptInboundWithReceipt(
      mail("child-b", "<child-b@example.com>", "<parent@example.com>", "2026-01-01T00:00:01.000Z"),
    );
    expect(childA.parentNodeId).toBe(childB.parentNodeId);
    const parent = await store.acceptInboundWithReceipt(
      mail("parent", "<parent@example.com>", null),
    );
    const conversation = await store.resolveConversation(childA.threadHandle);
    expect(conversation.messages.map((message) => message.id).sort()).toEqual([
      "child-a",
      "child-b",
      "parent",
    ]);
    expect(parent.nodeId).toBe(childA.parentNodeId);
  });

  it("rolls back a conflicting persist so no placeholder is left behind", async () => {
    const store = accountStore("threading-rollback");
    await store.acceptInboundWithReceipt(mail("same", "<first@example.com>", null));
    let failure: unknown;
    try {
      await store.acceptInboundWithReceipt(
        mail("same", "<second@example.com>", "<missing@example.com>", "2026-01-01T00:00:01.000Z"),
      );
    } catch (cause) {
      failure = cause;
    }
    expect(taggedName(failure)).toBe("MessageConflictError");
    expect(await store.inspectRfcLookup("<missing@example.com>")).toBeNull();
    expect(await store.inspectRfcLookup("<second@example.com>")).toBeNull();
    const first = await store.inspectRfcLookup("<first@example.com>");
    expect(first?.claimantNodeId).not.toBeNull();
  });

  it("records threading_limited and leaves a long-chain tail independently addressable", async () => {
    const store = accountStore("threading-budget");
    const budget = 3;
    await store.acceptInboundWithReceipt(mail("m1", "<m1@example.com>", null), budget);
    await store.acceptInboundWithReceipt(
      mail("m2", "<m2@example.com>", "<m1@example.com>"),
      budget,
    );
    await store.acceptInboundWithReceipt(
      mail("m3", "<m3@example.com>", "<m2@example.com>"),
      budget,
    );
    const fourth = await store.acceptInboundWithReceipt(
      mail("m4", "<m4@example.com>", "<m3@example.com>"),
      budget,
    );
    const limited = await store.acceptInboundWithReceipt(
      mail("m5", "<m5@example.com>", "<m4@example.com>"),
      budget,
    );
    expect(limited.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["threading_limited"]);
    expect(limited.parentNodeId).toBeNull();
    expect(
      (await store.resolveConversation(limited.threadHandle)).messages.map((message) => message.id),
    ).toEqual(["m5"]);
    expect(
      (await store.resolveConversation(fourth.threadHandle)).messages.map((message) => message.id),
    ).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("persists mailbox ids so a conversation is eligible from any live member mailbox", async () => {
    const store = accountStore("threading-visibility");
    const parent = await store.acceptInboundWithReceipt(
      mail("parent", "<parent@example.com>", null, "2026-01-01T00:00:00.000Z", "mbox-1"),
    );
    await store.acceptInboundWithReceipt(
      mail(
        "child",
        "<child@example.com>",
        "<parent@example.com>",
        "2026-01-01T00:00:01.000Z",
        "mbox-2",
      ),
    );
    const conversation = await store.resolveConversation(parent.threadHandle);
    expect(conversation.messages.map((message) => message.mailboxId)).toEqual(["mbox-1", "mbox-2"]);
    expect(conversationIsEligible(conversation.messages, ["mbox-1"])).toBe(true);
    expect(conversationIsEligible(conversation.messages, ["mbox-2"])).toBe(true);
    expect(conversationIsEligible(conversation.messages, ["mbox-3"])).toBe(false);
    expect(conversationIsEligible(conversation.messages, [])).toBe(false);
  });

  it("rejects an invalid or unknown thread handle", async () => {
    const store = accountStore("threading-handle-error");
    let invalid: unknown;
    try {
      await store.resolveConversation("rfc:not-a-node");
    } catch (cause) {
      invalid = cause;
    }
    expect(taggedName(invalid)).toBe("ThreadHandleError");
    let missing: unknown;
    try {
      await store.resolveConversation("node:550e8400-e29b-41d4-a716-446655440000");
    } catch (cause) {
      missing = cause;
    }
    expect(taggedName(missing)).toBe("ThreadHandleError");
  });

  it("adopts the placeholder a reply created before the send was accepted", async () => {
    const store = accountStore("threading-late-claim");
    const mailbox = await requireAddress(store, "inbox");
    const submitted = await store.submitOutbound(operatorSubmit(mailbox.id, REQUEST_A));
    const claimed = await store.claimDispatch({
      jobId: submitted.job.jobId,
      nowIso: NOW,
      claimExpiresAt: CLAIM_EXPIRES,
    });
    if (claimed.kind !== "claimed") {
      throw new Error("expected claim");
    }
    const reply = await store.acceptInboundWithReceipt(
      mail(
        "early-reply",
        "<early@example.com>",
        PROVIDER_ID,
        "2026-01-01T00:00:01.000Z",
        mailbox.id,
      ),
    );
    const placeholderNodeId = reply.parentNodeId;
    if (placeholderNodeId === null) {
      throw new Error("expected a placeholder parent");
    }
    expect(
      (await store.resolveConversation(submitted.job.threadHandle)).messages.map(
        (message) => message.id,
      ),
    ).toEqual([submitted.job.messageId]);

    expect(
      await store.completeAttempt({
        jobId: submitted.job.jobId,
        attemptId: claimed.attemptId,
        nowIso: LATER,
        outcome: { kind: "accepted", providerMessageId: "prov-1", rfcMessageId: PROVIDER_ID },
      }),
    ).toMatchObject({ kind: "applied", job: { state: "accepted" } });

    const page = await store.listThreadMessageSummaries(submitted.job.threadHandle, {
      mailboxScope: "all",
    });
    expect(page.items.map((item) => item.id).sort()).toEqual(
      ["early-reply", submitted.job.messageId].sort(),
    );
    expect(page.items.find((item) => item.id === "early-reply")?.parentMessageId).toBe(
      submitted.job.messageId,
    );
    const claimedConversation = await store.resolveConversation(submitted.job.threadHandle);
    expect((await store.resolveConversation(reply.threadHandle)).componentRootId).toBe(
      claimedConversation.componentRootId,
    );
    expect((await store.resolveConversation(`node:${placeholderNodeId}`)).componentRootId).toBe(
      claimedConversation.componentRootId,
    );
  });
});

function operatorSubmit(mailboxId: string, requestId: string) {
  return {
    requestId: Schema.decodeSync(SubmissionRequestId)(requestId),
    requester: { kind: "operator" as const, clientId: "cli", label: "AgentMail CLI" },
    mailboxId,
    mailDomain: DOMAIN,
    subject: "Direct",
    textBody: "body",
    htmlBody: null,
    hasRemoteImages: false,
    to: [{ address: requireExternal("recipient@example.com"), displayName: null }],
    cc: [],
    inReplyToHeader: null,
    referencesHeader: null,
    nowIso: NOW,
  };
}

async function requireAddress(store: DurableObjectStub<AccountStoreTestHost>, localPart: string) {
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

function mail(
  messageId: string,
  rfcMessageId: string | null,
  inReplyToHeader: string | null,
  occurredAt = "2026-01-01T00:00:00.000Z",
  mailboxId = "mbox-1",
) {
  return {
    messageId,
    mailboxId,
    rfcMessageId,
    inReplyToHeader,
    referencesHeader: inReplyToHeader,
    occurredAt,
    nowIso: occurredAt,
    parsedDate: null,
  };
}
