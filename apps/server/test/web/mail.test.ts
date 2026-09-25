import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  authorized,
  createWorld,
  operatorCookieHeaders,
  readJson,
  readText,
  seedInboundMessage,
  seedMailbox,
  type World,
} from "../api/world.ts";

const ThreadList = Schema.Struct({
  items: Schema.Array(Schema.Struct({ threadId: Schema.String, unreadCount: Schema.Finite })),
});

const page = Effect.fn("page")(function* (world: World, path: string) {
  const response = yield* world.request(`http://umail.test${path}`, {
    redirect: "manual",
    headers: { cookie: world.sessionCookie },
  });
  return { response, body: yield* readText(response.clone()) };
});

const post = Effect.fn("post")(function* (world: World, path: string) {
  return yield* world.request(`http://umail.test${path}`, {
    method: "POST",
    redirect: "manual",
    headers: operatorCookieHeaders(world.sessionCookie),
  });
});

const unreadCounts = Effect.fn("unreadCounts")(function* (world: World) {
  const response = yield* world.request("http://umail.test/threads", authorized(world));
  const list = yield* Schema.decodeUnknownEffect(ThreadList)(yield* readJson(response));
  return new Map(list.items.map((item) => [item.threadId, item.unreadCount]));
});

describe("mail pages", () => {
  it.effect("lists every mailbox's conversations, one mailbox's on request, unread marked", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      const probe = yield* seedMailbox(world, "probe");
      yield* seedInboundMessage(world, inbox.id, { id: "m-inbox", subject: "For the inbox" });
      yield* seedInboundMessage(world, probe.id, {
        id: "m-probe",
        subject: "For the probe <b>",
        to: ["probe@umail.example.com"],
        envelopeTo: "probe@umail.example.com",
      });

      const all = yield* page(world, "/mail");
      expect(all.response.status).toBe(200);
      expect(all.body).toContain("For the inbox");
      expect(all.body).toContain("For the probe &lt;b&gt;");
      expect(all.body.match(/class="thread unread"/gu)).toHaveLength(2);
      expect(all.body).toContain('class="chip">probe@</span>');

      const one = yield* page(world, `/mail?mailbox=${probe.id}`);
      expect(one.body).toContain("For the probe");
      expect(one.body).not.toContain("For the inbox");
      expect(one.body).not.toContain('class="chip">probe@');
      expect(one.body).toMatch(/aria-current="page">\s*<span class="mono">probe@/u);
    }),
  );

  it.effect("pages older conversations with a cursor", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      for (let index = 0; index < 27; index += 1) {
        const day = String(index + 1).padStart(2, "0");
        yield* seedInboundMessage(world, inbox.id, {
          id: `m-${day}`,
          subject: `Conversation ${day}`,
          occurredAt: `2026-01-${day}T00:00:00.000Z`,
        });
      }

      const first = yield* page(world, "/mail");
      expect(first.body).toContain("Conversation 27");
      expect(first.body).not.toContain("Conversation 01");
      const older = /href="(\/mail\?cursor=[^"]+)"/u.exec(first.body)?.[1];
      expect(older).toBeDefined();

      const second = yield* page(world, (older ?? "").replaceAll("&amp;", "&"));
      expect(second.body).toContain("Conversation 01");
      expect(second.body).not.toContain("Conversation 27");
    }),
  );

  it.effect("opens the newest message, marks the conversation read, and can mark it unread", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      const first = yield* seedInboundMessage(world, inbox.id, {
        id: "m-first",
        subject: "Plans",
        textBody: "First body",
        occurredAt: "2026-01-01T00:00:00.000Z",
      });
      yield* seedInboundMessage(world, inbox.id, {
        id: "m-second",
        subject: "Re: Plans",
        textBody: "Second body",
        inReplyToHeader: "<m-first@example.com>",
        occurredAt: "2026-01-02T00:00:00.000Z",
      });
      const threadPath = `/mail/threads/${first.threadId}`;
      expect((yield* unreadCounts(world)).get(first.threadId)).toBe(2);

      const opened = yield* page(world, threadPath);
      expect(opened.response.status).toBe(200);
      expect(opened.body).toContain("Second body");
      expect(opened.body).not.toContain("First body");
      expect(opened.body).toContain(`${threadPath}?open=m-first`);
      expect(opened.body).toContain("/mail/compose?reply=m-second&mode=reply-all");
      expect((yield* unreadCounts(world)).get(first.threadId)).toBe(0);

      const older = yield* page(world, `${threadPath}?open=m-first`);
      expect(older.body).toContain("First body");
      expect(older.body).not.toContain("Second body");

      const unread = yield* post(world, `${threadPath}/unread`);
      expect(unread.status).toBe(303);
      expect(unread.headers.get("location")).toBe("/mail?unread");
      expect((yield* unreadCounts(world)).get(first.threadId)).toBe(2);
    }),
  );

  it.effect("frames the HTML body in a sandbox that loads nothing, and lists inline images", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      const message = yield* seedInboundMessage(world, inbox.id, {
        id: "m-html",
        htmlBody: '<p>Hello</p><img src="/messages/m-html/attachments/logo" alt="Logo">',
        attachments: [
          {
            id: "logo",
            position: 0,
            filename: "logo.png",
            mimeType: "image/png",
            size: 4,
            r2Key: "mail/logo.png",
            contentId: "logo@example.com",
            disposition: "inline",
            isInline: true,
          },
        ],
      });

      const { response, body } = yield* page(world, "/mail/messages/m-html/body");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(response.status).toBe(200);
      expect(csp).toContain("sandbox");
      expect(csp).toContain("img-src 'none'");
      expect(csp).toContain("script-src 'none'");
      expect(response.headers.get("x-frame-options")).toBeNull();
      expect(body).toContain("<p>Hello</p>");

      const thread = yield* page(world, `/mail/threads/${message.threadId}`);
      expect(thread.body).toContain('src="/mail/messages/m-html/body"');
      expect(thread.body).toMatch(/sandbox=""/u);
      expect(thread.body).toContain("Images are not shown.");
      expect(thread.body).toContain("Inline images are listed as attachments below.");
      expect(thread.body).toContain('href="/mail/messages/m-html/attachments/logo"');

      const signedOut = yield* world.request("http://umail.test/mail/messages/m-html/body", {
        redirect: "manual",
      });
      expect(signedOut.status).toBe(303);
      expect(signedOut.headers.get("location")).toContain("/login?next=");
    }),
  );

  it.effect("downloads attachments and deletes conversations", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      const message = yield* seedInboundMessage(world, inbox.id, {
        id: "m-files",
        subject: "Invoice",
        attachments: [
          {
            id: "invoice",
            position: 0,
            filename: "invoice.bin",
            mimeType: "application/octet-stream",
            size: 3,
            r2Key: "mail/invoice.bin",
            contentId: null,
            disposition: "attachment",
            isInline: false,
          },
        ],
      });
      world.archive.put("mail/invoice.bin", new Uint8Array([1, 2, 3]));

      const thread = yield* page(world, `/mail/threads/${message.threadId}`);
      expect(thread.body).toContain('href="/mail/messages/m-files/attachments/invoice"');
      const download = yield* page(world, "/mail/messages/m-files/attachments/invoice");
      expect(download.response.status).toBe(200);
      expect(download.response.headers.get("content-disposition")).toContain(
        'attachment; filename="invoice.bin"',
      );

      const deleted = yield* post(world, `/mail/threads/${message.threadId}/delete`);
      expect(deleted.status).toBe(303);
      expect(deleted.headers.get("location")).toBe("/mail?deleted");
      const list = yield* page(world, "/mail?deleted");
      expect(list.body).toContain("Conversation deleted.");
      expect(list.body).not.toContain("Invoice");
    }),
  );
});
