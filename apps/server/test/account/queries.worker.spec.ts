/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject } from "cloudflare:test";
import { parseExternalMailAddress, parseMailDomain, type MailDomain } from "@umail/api-contract";
import { describe, expect, it } from "vitest";

import { accountStore, failureOf, taggedName } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");

describe("account-store bounded query commands", () => {
  it("requires an inbound receipt and rolls back rejected acceptance", async () => {
    const store = accountStore("queries-receipt-required");
    const mailbox = await requireAddress(store, "inbox");
    const input = mailInput(mailbox.id, 0, null, { messageId: "orphan-accept" });

    const failure = await failureOf(store, (host) => host.acceptInbound(input));

    expect(taggedName(failure)).toBe("InboundMessageIntegrityError");
    expect((await store.listMessageSummaries({ mailboxScope: "all" })).items).toEqual([]);
  });

  it("reads exact envelope metadata and live forwarding observations from receipts", async () => {
    const store = accountStore("queries-receipt-metadata");
    const mailbox = await requireAddress(store, "inbox");
    const cases = [
      { id: "meta-none", forward: null },
      {
        id: "meta-unknown",
        forward: { kind: "unknown", destination: "unknown@example.net" } as const,
      },
      {
        id: "meta-success",
        forward: { kind: "success", destination: "success@example.net" } as const,
      },
      {
        id: "meta-failure",
        forward: { kind: "failure", destination: "failure@example.net" } as const,
      },
    ] as const;
    for (let index = 0; index < cases.length; index += 1) {
      const fixture = cases[index];
      if (fixture === undefined) continue;
      const occurredAt = isoAt(index);
      await registerReceipt(store, fixture.id, occurredAt, {
        envelopeFrom: fixture.id === "meta-none" ? "" : `bounce-${String(index)}@example.net`,
        envelopeTo: "bcc-inbox@umail.example.com",
      });
      if (fixture.forward !== null) {
        await store.observeInboundForward({ receiptId: fixture.id, observation: fixture.forward });
      }
      const base = mailInput(mailbox.id, index, null, {
        messageId: fixture.id,
        occurredAt,
        parsedDate: "2025-12-31T23:00:00.000Z",
      });
      await store.acceptInbound({
        ...base,
        from: [{ address: requireExternal("header-sender@example.com"), displayName: null }],
        to: [],
        cc: [],
      });
    }

    const page = await store.listMessageSummaries({ mailboxScope: "all" });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    const none = byId.get("meta-none");
    expect(none?.direction).toBe("inbound");
    if (none?.direction === "inbound") {
      expect(none.envelopeFrom).toBe("");
      expect(none.envelopeTo).toBe("bcc-inbox@umail.example.com");
      expect(none.from.map((contact) => contact.address)).toEqual(["header-sender@example.com"]);
      expect(none.to).toEqual([]);
      expect(none.parsedDate).toBe("2025-12-31T23:00:00.000Z");
      expect(none.forwardOutcome).toBe("none");
      expect(none.forwardDestination).toBeNull();
    }
    for (const fixture of cases.slice(1)) {
      const summary = byId.get(fixture.id);
      expect(summary?.direction).toBe("inbound");
      if (summary?.direction === "inbound") {
        expect(summary.forwardOutcome).toBe(fixture.forward?.kind);
        expect(summary.forwardDestination).toBe(fixture.forward?.destination);
      }
    }

    await store.observeInboundForward({
      receiptId: "meta-unknown",
      observation: { kind: "success", destination: "unknown@example.net" },
    });
    const refreshed = await store.listMessageSummaries({ mailboxScope: "all" });
    const updated = refreshed.items.find((item) => item.id === "meta-unknown");
    expect(updated?.direction).toBe("inbound");
    if (updated?.direction === "inbound") {
      expect(updated.forwardOutcome).toBe("success");
      expect(updated.forwardDestination).toBe("unknown@example.net");
    }
  });

  it("keeps direction metadata and cursors correct across mixed inbound and outbound pages", async () => {
    const store = accountStore("queries-mixed-directions");
    const mailbox = await requireAddress(store, "inbox");
    await persistMail(store, mailbox.id, 0, null, { messageId: "inbound-old" });
    await store.acceptOutbound(outboundInput(mailbox.id, 1, "outbound-old"));
    await persistMail(store, mailbox.id, 2, null, { messageId: "inbound-new" });
    await store.acceptOutbound(outboundInput(mailbox.id, 3, "outbound-new"));

    const first = await store.listMessageSummaries({ mailboxScope: "all", limit: 2 });
    expect(first.items.map((item) => [item.id, item.direction])).toEqual([
      ["outbound-new", "outbound"],
      ["inbound-new", "inbound"],
    ]);
    expect(first.nextCursor).not.toBeNull();
    if (first.nextCursor === null) {
      throw new Error("expected a mixed-direction page cursor");
    }
    const second = await store.listMessageSummaries({
      mailboxScope: "all",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => [item.id, item.direction])).toEqual([
      ["outbound-old", "outbound"],
      ["inbound-old", "inbound"],
    ]);
    expect(second.nextCursor).toBeNull();
    for (const summary of [...first.items, ...second.items]) {
      if (summary.direction === "inbound") {
        expect(summary).toHaveProperty("forwardOutcome");
        expect(summary).not.toHaveProperty("outboundJob");
      } else {
        expect(summary.outboundJob.state).toBe("unknown");
        expect(summary).not.toHaveProperty("forwardOutcome");
      }
    }
  });

  it("fails public reads for an orphaned inbound message", async () => {
    const store = accountStore("queries-orphan-read");
    const mailbox = await requireAddress(store, "inbox");
    await persistMail(store, mailbox.id, 0, null, { messageId: "orphan-read" });
    await store.removeInboundReceiptForIntegrityTest("orphan-read");

    const failure = await failureOf(store, (host) =>
      host.listMessageSummaries({ mailboxScope: "all" }),
    );
    expect(taggedName(failure)).toBe("InboundMessageIntegrityError");
  });

  it("persists normalized parsed date independently of receipt occurrence time across restart", async () => {
    const store = accountStore("queries-parsed-date-restart");
    const mailbox = await requireAddress(store, "inbox");
    await persistMail(store, mailbox.id, 0, null, {
      messageId: "dated-message",
      occurredAt: "2026-01-02T03:04:05.000Z",
      parsedDate: "2020-06-07T08:09:10.000Z",
    });
    await evictDurableObject(store);

    const page = await store.listMessageSummaries({ mailboxScope: "all" });
    const summary = page.items[0];
    expect(summary?.direction).toBe("inbound");
    if (summary?.direction === "inbound") {
      expect(summary.parsedDate).toBe("2020-06-07T08:09:10.000Z");
      expect(summary.occurredAt).toBe("2026-01-02T03:04:05.000Z");
    }
  });

  it("enriches 100, 101, and 200 message ids through json_each", async () => {
    const store = accountStore("queries-id-reads");
    const mailbox = await requireAddress(store, "inbox");
    await seedMessages(store, mailbox.id, 200);
    const hundred = await store.listMessageSummaries({
      mailboxScope: "all",
      limit: 100,
    });
    expect(hundred.items).toHaveLength(100);
    expect(hundred.nextCursor).not.toBeNull();
    expectCompleteMetadata(hundred.items);
    expect(hundred.items.some((item) => "textBody" in item || "htmlBody" in item)).toBe(false);

    const hundredAndOne = await store.listMessageSummaries({
      mailboxScope: "all",
      limit: 101,
    });
    expect(hundredAndOne.items).toHaveLength(101);
    expectCompleteMetadata(hundredAndOne.items);

    const twoHundred = await store.listMessageSummaries({
      mailboxScope: "all",
      limit: 200,
    });
    expect(twoHundred.items).toHaveLength(200);
    expect(twoHundred.nextCursor).toBeNull();
    expectCompleteMetadata(twoHundred.items);
    expect(twoHundred.items[0]?.attachments[0]?.filename).toBe("file-199.bin");
  });

  it("pages a thread with more than 200 messages and keeps bodies separate", async () => {
    const store = accountStore("queries-thread-page");
    const mailbox = await requireAddress(store, "inbox");
    const first = await persistMail(store, mailbox.id, 0, null);
    for (let index = 1; index < 201; index += 1) {
      await persistMail(store, mailbox.id, index, "<root-0@example.com>");
    }
    const page = await store.listThreadMessageSummaries(first.threadId, {
      mailboxScope: "all",
      limit: 200,
    });
    expect(page.items).toHaveLength(200);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items.map((item) => item.id)).toEqual(idsFor(200));
    expect(page.items[0]?.id).toBe("msg-0");
    const cursor = page.nextCursor;
    if (cursor === null) {
      throw new Error("expected a thread-message cursor");
    }
    const next = await store.listThreadMessageSummaries(first.threadId, {
      mailboxScope: "all",
      limit: 200,
      cursor,
    });
    expect(next.items.map((item) => item.id)).toEqual(["msg-200"]);
    expect(next.nextCursor).toBeNull();
    const body = await store.getMessageBody("msg-0", "all");
    expect(body).toMatchObject({
      id: "msg-0",
      textBody: "body-0",
      htmlBody: "<p>0</p>",
    });
    expect(page.items[0]).not.toHaveProperty("textBody");
  });

  it("orders equal timestamps by id and omits deleted messages", async () => {
    const store = accountStore("queries-equal-time");
    const mailbox = await requireAddress(store, "inbox");
    const first = await persistMail(store, mailbox.id, 0, null, {
      messageId: "msg-a",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    await persistMail(store, mailbox.id, 1, "<root-0@example.com>", {
      messageId: "msg-b",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    const page = await store.listMessageSummaries({
      mailboxScope: "all",
      limit: 1,
    });
    expect(page.items.map((item) => item.id)).toEqual(["msg-b"]);
    const cursor = page.nextCursor;
    if (cursor === null) {
      throw new Error("expected a message cursor");
    }
    const next = await store.listMessageSummaries({
      mailboxScope: "all",
      limit: 1,
      cursor,
    });
    expect(next.items.map((item) => item.id)).toEqual(["msg-a"]);
    await store.softDeleteThread(first.threadId, "all", "2026-01-01T00:00:02.000Z");
    const afterDelete = await store.listMessageSummaries({ mailboxScope: "all" });
    expect(afterDelete.items.map((item) => item.id)).toEqual([]);
  });
});

describe("account-store thread reads", () => {
  it("pages threads newest-first across tied activity and a deleted latest message", async () => {
    const store = accountStore("queries-thread-list-paging");
    const inbox = await requireAddress(store, "inbox");
    const other = await requireAddress(store, "other");
    await persistMail(store, inbox.id, 1, null, { messageId: "t1", occurredAt: isoAt(0) });
    await persistMail(store, inbox.id, 2, null, { messageId: "t2", occurredAt: isoAt(1) });
    await persistMail(store, other.id, 3, "<root-2@example.com>", {
      messageId: "t2-latest",
      occurredAt: isoAt(9),
    });
    await persistMail(store, inbox.id, 4, null, { messageId: "t3", occurredAt: isoAt(3) });
    await persistMail(store, inbox.id, 5, null, { messageId: "t4", occurredAt: isoAt(3) });
    await persistMail(store, inbox.id, 6, null, { messageId: "t5", occurredAt: isoAt(4) });
    await store.softDeleteThread("t2", [other.id], isoAt(10));

    const query = { mailboxScope: "all" as const, limit: 2 };
    let page = await store.listThreadSummaries(query);
    const items = [...page.items];
    while (page.nextCursor !== null && items.length < 10) {
      page = await store.listThreadSummaries({ ...query, cursor: page.nextCursor });
      items.push(...page.items);
    }
    const seen = items.map((item) => [item.threadHandle, item.lastActivityAt, item.messageCount]);
    expect(seen).toEqual([
      ["t5", isoAt(4), 1],
      ["t4", isoAt(3), 1],
      ["t3", isoAt(3), 1],
      ["t2", isoAt(1), 1],
      ["t1", isoAt(0), 1],
    ]);
  });

  it("keeps two threads' messages apart", async () => {
    const store = accountStore("queries-thread-isolation");
    const inbox = await requireAddress(store, "inbox");
    const a = await persistMail(store, inbox.id, 0, null, { messageId: "a-root" });
    await persistMail(store, inbox.id, 1, "<root-0@example.com>", { messageId: "a-reply" });
    const b = await persistMail(store, inbox.id, 2, null, { messageId: "b-root" });
    await persistMail(store, inbox.id, 3, "<root-2@example.com>", { messageId: "b-reply" });

    const members = async (threadId: string) =>
      (await store.listThreadMessageSummaries(threadId, { mailboxScope: "all" })).items.map(
        (item) => [item.id, item.threadHandle, item.parentMessageId],
      );
    expect(await members(a.threadId)).toEqual([
      ["a-root", "a-root", null],
      ["a-reply", "a-root", "a-root"],
    ]);
    expect(await members(b.threadId)).toEqual([
      ["b-root", "b-root", null],
      ["b-reply", "b-root", "b-root"],
    ]);
  });

  it("opens a thread through messages_thread_idx", async () => {
    const plan = await accountStore("queries-thread-plan").explainThreadOpen();
    expect(plan).toContain("SEARCH msg USING INDEX messages_thread_idx (thread_id=?)");
  });
});

describe("account-store message source read", () => {
  it("resolves an in-scope inbound message to its receipt's raw key", async () => {
    const store = accountStore("queries-source-inbound");
    const mailbox = await requireAddress(store, "inbox");
    await persistMail(store, mailbox.id, 0, null, { messageId: "source-inbound" });

    const expected = {
      direction: "inbound",
      messageId: "source-inbound",
      mailboxId: mailbox.id,
      rawKey: "raw/source-inbound",
    };
    expect(await store.getMessageSource("source-inbound", "all")).toEqual(expected);
    expect(await store.getMessageSource("source-inbound", [mailbox.id])).toEqual(expected);
  });

  it("answers an outbound message with the outbound variant and no raw key", async () => {
    const store = accountStore("queries-source-outbound");
    const mailbox = await requireAddress(store, "inbox");
    await store.acceptOutbound(outboundInput(mailbox.id, 0, "source-outbound"));

    const source = await store.getMessageSource("source-outbound", [mailbox.id]);
    expect(source).toEqual({
      direction: "outbound",
      messageId: "source-outbound",
      mailboxId: mailbox.id,
    });
    expect(source).not.toHaveProperty("rawKey");
  });

  it("returns null for a soft-deleted message", async () => {
    const store = accountStore("queries-source-deleted");
    const mailbox = await requireAddress(store, "inbox");
    const persisted = await persistMail(store, mailbox.id, 0, null, {
      messageId: "source-deleted",
    });
    expect(await store.getMessageSource("source-deleted", "all")).not.toBeNull();
    await store.softDeleteThread(persisted.threadId, "all", "2026-01-01T00:00:02.000Z");

    expect(await store.getMessageSource("source-deleted", "all")).toBeNull();
  });

  it("returns null for a message outside the mailbox scope", async () => {
    const store = accountStore("queries-source-scope");
    const mailbox = await requireAddress(store, "inbox");
    const other = await requireAddress(store, "other");
    await persistMail(store, mailbox.id, 0, null, { messageId: "source-scoped" });

    expect(await store.getMessageSource("source-scoped", [other.id])).toBeNull();
    expect(await store.getMessageSource("source-scoped", [])).toBeNull();
  });

  it("returns null for an unknown message id", async () => {
    const store = accountStore("queries-source-unknown");
    await requireAddress(store, "inbox");

    expect(await store.getMessageSource("no-such-message", "all")).toBeNull();
  });
});

function expectCompleteMetadata(
  items: ReadonlyArray<{
    readonly from: ReadonlyArray<unknown>;
    readonly to: ReadonlyArray<unknown>;
    readonly references: ReadonlyArray<unknown>;
    readonly attachments: ReadonlyArray<unknown>;
  }>,
) {
  for (const item of items) {
    expect(item.from.length).toBeGreaterThan(0);
    expect(item.to.length).toBeGreaterThan(0);
    expect(item.attachments.length).toBeGreaterThan(0);
    expect(Array.isArray(item.references)).toBe(true);
  }
}

async function seedMessages(
  store: DurableObjectStub<AccountStoreTestHost>,
  mailboxId: string,
  count: number,
) {
  for (let index = 0; index < count; index += 1) {
    await persistMail(store, mailboxId, index, null);
  }
}

async function persistMail(
  store: DurableObjectStub<AccountStoreTestHost>,
  mailboxId: string,
  index: number,
  inReplyTo: string | null,
  overrides?: {
    readonly messageId?: string;
    readonly occurredAt?: string;
    readonly parsedDate?: string | null;
  },
) {
  return store.acceptInboundWithReceipt(mailInput(mailboxId, index, inReplyTo, overrides));
}

function mailInput(
  mailboxId: string,
  index: number,
  inReplyTo: string | null,
  overrides?: {
    readonly messageId?: string;
    readonly occurredAt?: string;
    readonly parsedDate?: string | null;
  },
) {
  const messageId = overrides?.messageId ?? `msg-${String(index)}`;
  const occurredAt = overrides?.occurredAt ?? isoAt(index);
  const rfcMessageId = `<root-${String(index)}@example.com>`;
  return {
    messageId,
    mailboxId,
    rfcMessageId,
    inReplyToHeader: inReplyTo,
    referencesHeader: inReplyTo,
    occurredAt,
    nowIso: occurredAt,
    parsedDate: overrides?.parsedDate ?? null,
    subject: `Subject ${String(index)}`,
    textBody: `body-${String(index)}`,
    htmlBody: `<p>${String(index)}</p>`,
    hasRemoteImages: false,
    from: [{ address: requireExternal("sender@example.com"), displayName: "Sender" }],
    replyTo: [],
    to: [{ address: requireExternal("inbox@umail.example.com"), displayName: "Inbox" }],
    cc: [],
    attachments: [
      {
        id: `att-${messageId}`,
        position: 0,
        filename: `file-${String(index)}.bin`,
        mimeType: "application/octet-stream",
        size: 4,
        r2Key: `attachments/${messageId}`,
        contentId: null,
        disposition: "attachment",
        isInline: false,
      },
    ],
  };
}

function outboundInput(mailboxId: string, index: number, messageId: string) {
  const occurredAt = isoAt(index);
  return {
    messageId,
    mailboxId,
    rfcMessageId: `<outbound-${String(index)}@example.com>`,
    inReplyToHeader: null,
    referencesHeader: null,
    occurredAt,
    nowIso: occurredAt,
    subject: `Outbound ${String(index)}`,
    textBody: `outbound-${String(index)}`,
    htmlBody: null,
    hasRemoteImages: false,
    from: [{ address: requireExternal("inbox@umail.example.com"), displayName: "Inbox" }],
    replyTo: [],
    to: [{ address: requireExternal("recipient@example.net"), displayName: null }],
    cc: [],
    attachments: [],
  };
}

type ReceiptEnvelopeSeed = {
  readonly envelopeFrom: string;
  readonly envelopeTo: string;
};

async function registerReceipt(
  store: DurableObjectStub<AccountStoreTestHost>,
  messageId: string,
  receivedAt: string,
  envelope: ReceiptEnvelopeSeed,
): Promise<void> {
  await store.registerInboundReceipt({
    receiptId: messageId,
    envelopeFrom: envelope.envelopeFrom,
    envelopeTo: envelope.envelopeTo,
    rawKey: `raw/${messageId}`,
    receivedAt,
  });
}

async function requireAddress(store: DurableObjectStub<AccountStoreTestHost>, localPart: string) {
  const created = await store.createAddress(localPart, DOMAIN, localPart, NOW);
  if (created === null) {
    throw new Error(`expected address ${localPart}`);
  }
  return created;
}

function idsFor(count: number): Array<string> {
  const ids: Array<string> = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(`msg-${String(index)}`);
  }
  return ids;
}

function isoAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
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
