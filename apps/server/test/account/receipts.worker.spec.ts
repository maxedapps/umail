/// <reference types="@cloudflare/vitest-plugin/types" />

import { describe, expect, it } from "vitest";

import { accountStore, failureOf } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const SENDER = "sender@example.com";
const INBOX = "inbox@umail.example.com";
const DESTINATION = "owner@example.net";

type Store = DurableObjectStub<AccountStoreTestHost>;

describe("inbound receipts", () => {
  it("registers a receipt once, due for redrive five minutes after it arrived", async () => {
    const store = accountStore("receipts-register");
    await register(store, "in_a", at(0));
    await register(store, "in_a", at(3));

    expect(await store.getInboundReceipt("in_a")).toEqual({
      receiptId: "in_a",
      envelopeFrom: SENDER,
      envelopeTo: INBOX,
      rawKey: "raw/in_a.eml",
      receivedAt: at(0),
      forwardOutcome: "none",
      forwardDestination: null,
      workState: "ready",
      policyError: null,
      retryAfter: at(5),
    });
  });

  it("keeps redriving a stuck receipt with age-based backoff capped at 30 minutes", async () => {
    // F3: the old attempt budget parked a receipt for good after 8 redrives; it now stays ready.
    const store = accountStore("receipts-redrive-forever");
    await register(store, "in_stuck", at(0));

    const redrivenAt: number[] = [];
    for (let minute = 0; minute <= 240; minute += 1) {
      const due = await store.redriveDueInboundReceipts({ nowIso: at(minute), limit: 50 });
      if (due.includes("in_stuck")) redrivenAt.push(minute);
    }

    expect(redrivenAt).toEqual([5, 10, 20, 40, 70, 100, 130, 160, 190, 220]);
    expect(await store.getInboundReceipt("in_stuck")).toMatchObject({
      workState: "ready",
      retryAfter: at(250),
    });
  });

  it("returns only due ready receipts, oldest due first, within the limit", async () => {
    const store = accountStore("receipts-due");
    await register(store, "in_indexed", at(0));
    await store.acceptInbound(mailInput("in_indexed"));
    await register(store, "in_policy", at(0));
    await store.failInboundReceiptPolicy({ receiptId: "in_policy", reason: "parse_failed" });
    await register(store, "in_early", at(0));
    await register(store, "in_late", at(1));
    await register(store, "in_fresh", at(4));

    expect(await store.redriveDueInboundReceipts({ nowIso: at(4), limit: 50 })).toEqual([]);
    expect(await store.redriveDueInboundReceipts({ nowIso: at(6), limit: 1 })).toEqual([
      "in_early",
    ]);
    expect(await store.redriveDueInboundReceipts({ nowIso: at(6), limit: 50 })).toEqual([
      "in_late",
    ]);

    expect((await store.getInboundReceipt("in_early"))?.retryAfter).toBe(at(12));
    expect((await store.getInboundReceipt("in_late"))?.retryAfter).toBe(at(11));
    expect((await store.getInboundReceipt("in_fresh"))?.retryAfter).toBe(at(9));
  });

  it("indexes atomically and only while the receipt is ready", async () => {
    const store = accountStore("receipts-accept");
    await register(store, "in_ok", at(0));
    expect(await store.acceptInbound(mailInput("in_ok"))).toEqual({
      messageId: "in_ok",
      threadId: "in_ok",
    });
    expect((await store.getInboundReceipt("in_ok"))?.workState).toBe("indexed");
    expect(await store.acceptInbound(mailInput("in_ok"))).toBeNull();

    await register(store, "in_policy", at(0));
    await store.failInboundReceiptPolicy({ receiptId: "in_policy", reason: "mime_budget" });
    expect(await store.acceptInbound(mailInput("in_policy"))).toBeNull();

    // The second attachment breaks UNIQUE (message_id, position) after the message row is written.
    await register(store, "in_broken", at(0));
    const failure = await failureOf(store, (host) =>
      host.acceptInbound({
        ...mailInput("in_broken"),
        attachments: [attachment("in_broken", "a"), attachment("in_broken", "b")],
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect((await store.getInboundReceipt("in_broken"))?.workState).toBe("ready");

    const listed = await store.listMessageSummaries({ mailboxScope: "all" });
    expect(listed.items.map((item) => item.id)).toEqual(["in_ok"]);
  });

  it("moves forward observations and policy failures only out of the states they may leave", async () => {
    const store = accountStore("receipts-guards");
    const unknown = { kind: "unknown", destination: DESTINATION } as const;
    const success = { kind: "success", destination: DESTINATION } as const;
    const failed = { kind: "failure", destination: DESTINATION } as const;
    await register(store, "in_forward", at(0));

    expect(await observe(store, "in_forward", unknown)).toBe(true);
    expect(await observe(store, "in_forward", unknown)).toBe(false);
    expect(await observe(store, "in_forward", success)).toBe(true);
    expect(await observe(store, "in_forward", failed)).toBe(false);
    expect(await store.getInboundReceipt("in_forward")).toMatchObject({
      forwardOutcome: "success",
      forwardDestination: DESTINATION,
    });

    await store.acceptInbound(mailInput("in_forward"));
    await store.failInboundReceiptPolicy({ receiptId: "in_forward", reason: "parse_failed" });
    expect(await store.getInboundReceipt("in_forward")).toMatchObject({
      workState: "indexed",
      policyError: null,
    });

    await register(store, "in_policy", at(0));
    await store.failInboundReceiptPolicy({ receiptId: "in_policy", reason: "attachment_cap" });
    await store.failInboundReceiptPolicy({ receiptId: "in_policy", reason: "parse_failed" });
    expect(await store.getInboundReceipt("in_policy")).toMatchObject({
      workState: "policy_failed",
      policyError: "attachment_cap",
    });
  });
});

function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString();
}

function register(store: Store, receiptId: string, receivedAt: string) {
  return store.registerInboundReceipt({
    receiptId,
    envelopeFrom: SENDER,
    envelopeTo: INBOX,
    rawKey: `raw/${receiptId}.eml`,
    receivedAt,
  });
}

function observe(
  store: Store,
  receiptId: string,
  observation: Parameters<AccountStoreTestHost["observeInboundForward"]>[0]["observation"],
) {
  return store.observeInboundForward({ receiptId, observation });
}

function mailInput(messageId: string) {
  return {
    messageId,
    mailboxId: "mbox-1",
    rfcMessageId: `<${messageId}@example.com>`,
    inReplyToHeader: null,
    referencesHeader: null,
    occurredAt: at(0),
    nowIso: at(0),
    parsedDate: null,
    subject: "Hello",
    textBody: "body",
    htmlBody: null,
  };
}

function attachment(messageId: string, suffix: string) {
  return {
    id: `att_${messageId}_${suffix}`,
    position: 0,
    filename: `${suffix}.txt`,
    mimeType: "text/plain",
    size: 1,
    r2Key: `attachments/${messageId}/${suffix}`,
    contentId: null,
    disposition: null,
    isInline: false,
  };
}
