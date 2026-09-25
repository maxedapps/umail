/// <reference types="@cloudflare/vitest-plugin/types" />

import { parseExternalMailAddress, parseMailDomain, type MailDomain } from "@umail/api-contract";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { accountStore, failureOf, taggedName } from "./harness.ts";
import type { AccountStoreTestHost } from "./worker-host.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const DOMAIN = requireMailDomain("umail.example.com");

describe("account-store scoped visibility and mutations", () => {
  it.effect("shows a scoped reader only its mailboxes' part of a mixed-mailbox conversation", () =>
    Effect.gen(function* () {
      const store = accountStore("auth-mixed-mailbox");
      const inbox = yield* requireAddress(store, "inbox");
      const probe = yield* requireAddress(store, "probe");
      const parent = yield* persistMail(
        store,
        inbox.id,
        "parent",
        null,
        "2026-01-01T00:00:00.000Z",
      );
      yield* persistMail(
        store,
        probe.id,
        "child",
        "<parent@example.com>",
        "2026-01-01T00:00:01.000Z",
      );

      const threads = yield* Effect.promise(() =>
        store.listThreadSummaries({
          mailboxScope: [inbox.id],
        }),
      );
      expect(threads.items).toHaveLength(1);
      expect(threads.items[0]?.subject).toBe("parent");
      expect(threads.items[0]?.messageCount).toBe(1);
      expect(threads.items[0]?.unreadCount).toBe(1);
      expect(threads.items[0]?.involvedMailboxIdentities.map((identity) => identity.id)).toEqual([
        inbox.id,
      ]);

      for (const handle of [parent.threadId, "child"]) {
        const messages = yield* Effect.promise(() =>
          store.listThreadMessageSummaries(handle, {
            mailboxScope: [inbox.id],
          }),
        );
        expect(messages.items.map((item) => item.id)).toEqual(["parent"]);
      }
      const everything = yield* Effect.promise(() =>
        store.listThreadSummaries({ mailboxScope: "all" }),
      );
      expect(everything.items[0]?.messageCount).toBe(2);

      expect(yield* Effect.promise(() => store.getMessageBody("parent", [inbox.id]))).toMatchObject(
        {
          id: "parent",
          textBody: "body-parent",
        },
      );
      expect(yield* Effect.promise(() => store.getMessageBody("child", [inbox.id]))).toBeNull();
      expect(
        yield* Effect.promise(() => store.getStoredAttachment("child", "att-child", [inbox.id])),
      ).toBeNull();
      expect(
        yield* Effect.promise(() => store.getStoredAttachment("parent", "att-parent", [inbox.id])),
      ).toMatchObject({
        messageId: "parent",
        r2Key: "attachments/parent",
      });

      yield* Effect.promise(() =>
        store.markThreadRead(parent.threadId, true, [inbox.id], "2026-01-01T00:00:02.000Z"),
      );
      const afterRead = yield* Effect.promise(() =>
        store.listThreadMessageSummaries(parent.threadId, {
          mailboxScope: "all",
        }),
      );
      expect(afterRead.items.find((item) => item.id === "parent")?.isRead).toBe(true);
      expect(afterRead.items.find((item) => item.id === "child")?.isRead).toBe(false);

      yield* Effect.promise(() =>
        store.softDeleteThread(parent.threadId, [inbox.id], "2026-01-01T00:00:03.000Z"),
      );
      const afterDelete = yield* Effect.promise(() =>
        store.listThreadMessageSummaries(parent.threadId, {
          mailboxScope: [probe.id],
        }),
      );
      expect(afterDelete.items.map((item) => item.id)).toEqual(["child"]);
      expect(yield* Effect.promise(() => store.getMessageBody("parent", "all"))).toBeNull();
      expect(yield* Effect.promise(() => store.getMessageBody("child", [probe.id]))).toMatchObject({
        id: "child",
      });
    }),
  );

  it.effect("hides conversations that have no live in-scope mailbox message", () =>
    Effect.gen(function* () {
      const store = accountStore("auth-hidden-thread");
      const inbox = yield* requireAddress(store, "inbox");
      const probe = yield* requireAddress(store, "probe");
      const other = yield* persistMail(store, probe.id, "other", null, "2026-01-01T00:00:00.000Z");
      const hidden = yield* Effect.promise(() =>
        store.listThreadSummaries({
          mailboxScope: [inbox.id],
        }),
      );
      expect(hidden.items).toEqual([]);
      const missing = yield* failureOf(store, (host) =>
        host.listThreadMessageSummaries(other.threadId, {
          mailboxScope: [inbox.id],
        }),
      );
      expect(taggedName(missing)).toBe("ThreadNotFoundError");
      const empty = yield* Effect.promise(() => store.listMessageSummaries({ mailboxScope: [] }));
      expect(empty.items).toEqual([]);
    }),
  );
});

function persistMail(
  store: DurableObjectStub<AccountStoreTestHost>,
  mailboxId: string,
  messageId: string,
  inReplyTo: string | null,
  occurredAt: string,
) {
  return Effect.promise(() =>
    store.acceptInboundWithReceipt({
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
    }),
  );
}

const requireAddress = Effect.fn("requireAddress")(function* (
  store: DurableObjectStub<AccountStoreTestHost>,
  localPart: string,
) {
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
