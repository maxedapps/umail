/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseExternalMailAddress, parseMailDomain, type MailDomain } from "@umail/api-contract";
import { describe, expect, it } from "vitest";

import { accountStore, failureOf, taggedName } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");

describe("account-store scoped visibility and mutations", () => {
  it("shows mixed-mailbox conversation summaries while scoping bodies and mutations", async () => {
    const store = accountStore("auth-mixed-mailbox");
    const inbox = await requireAddress(store, "inbox");
    const probe = await requireAddress(store, "probe");
    const parent = await persistMail(store, inbox.id, "parent", null, "2026-01-01T00:00:00.000Z");
    await persistMail(store, probe.id, "child", "<parent@example.com>", "2026-01-01T00:00:01.000Z");

    const threads = await store.listThreadSummaries({
      mailboxScope: [inbox.id],
    });
    expect(threads.items).toHaveLength(1);
    expect(threads.items[0]?.messageCount).toBe(2);
    expect(
      threads.items[0]?.involvedMailboxIdentities.map((identity) => identity.id).sort(),
    ).toEqual([inbox.id, probe.id].sort());

    const messages = await store.listThreadMessageSummaries(parent.threadId, {
      mailboxScope: [inbox.id],
    });
    expect(messages.items.map((item) => item.id)).toEqual(["parent", "child"]);

    expect(await store.getMessageBody("parent", [inbox.id])).toMatchObject({
      id: "parent",
      textBody: "body-parent",
    });
    expect(await store.getMessageBody("child", [inbox.id])).toBeNull();
    expect(await store.getStoredAttachment("child", "att-child", [inbox.id])).toBeNull();
    expect(await store.getStoredAttachment("parent", "att-parent", [inbox.id])).toMatchObject({
      messageId: "parent",
      r2Key: "attachments/parent",
    });

    await store.markThreadRead(parent.threadId, true, [inbox.id], "2026-01-01T00:00:02.000Z");
    const afterRead = await store.listThreadMessageSummaries(parent.threadId, {
      mailboxScope: [inbox.id],
    });
    expect(afterRead.items.find((item) => item.id === "parent")?.isRead).toBe(true);
    expect(afterRead.items.find((item) => item.id === "child")?.isRead).toBe(false);

    await store.softDeleteThread(parent.threadId, [inbox.id], "2026-01-01T00:00:03.000Z");
    const afterDelete = await store.listThreadMessageSummaries(parent.threadId, {
      mailboxScope: [probe.id],
    });
    expect(afterDelete.items.map((item) => item.id)).toEqual(["child"]);
    expect(await store.getMessageBody("parent", "all")).toBeNull();
    expect(await store.getMessageBody("child", [probe.id])).toMatchObject({ id: "child" });
  });

  it("hides conversations that have no live in-scope mailbox message", async () => {
    const store = accountStore("auth-hidden-thread");
    const inbox = await requireAddress(store, "inbox");
    const probe = await requireAddress(store, "probe");
    const other = await persistMail(store, probe.id, "other", null, "2026-01-01T00:00:00.000Z");
    const hidden = await store.listThreadSummaries({
      mailboxScope: [inbox.id],
    });
    expect(hidden.items).toEqual([]);
    const missing = await failureOf(store, (host) =>
      host.listThreadMessageSummaries(other.threadId, {
        mailboxScope: [inbox.id],
      }),
    );
    expect(taggedName(missing)).toBe("ThreadHandleError");
    const empty = await store.listMessageSummaries({ mailboxScope: [] });
    expect(empty.items).toEqual([]);
  });
});

async function persistMail(
  store: DurableObjectStub<AccountStoreTestHost>,
  mailboxId: string,
  messageId: string,
  inReplyTo: string | null,
  occurredAt: string,
) {
  return store.acceptInboundWithReceipt({
    messageId,
    mailboxId,
    rfcMessageId: `<${messageId}@example.com>`,
    inReplyToHeader: inReplyTo,
    referencesHeader: inReplyTo,
    occurredAt,
    nowIso: occurredAt,
    parsedDate: null,
    subject: messageId,
    textBody: `body-${messageId}`,
    htmlBody: null,
    hasRemoteImages: false,
    from: [{ address: requireExternal("sender@example.com"), displayName: null }],
    replyTo: [],
    to: [{ address: requireExternal("inbox@umail.example.com"), displayName: null }],
    cc: [],
    attachments: [
      {
        id: `att-${messageId}`,
        position: 0,
        filename: `${messageId}.bin`,
        mimeType: "application/octet-stream",
        size: 1,
        r2Key: `attachments/${messageId}`,
        contentId: null,
        disposition: "attachment",
        isInline: false,
      },
    ],
  });
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
