import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  createWorld,
  operatorCookieHeaders,
  readText,
  seedInboundMessage,
  seedMailbox,
  type World,
} from "../api/world.ts";

const page = Effect.fn("page")(function* (world: World, path: string) {
  const response = yield* world.request(`http://umail.test${path}`, {
    headers: { cookie: world.sessionCookie },
  });
  return { status: response.status, body: yield* readText(response) };
});

const send = Effect.fn("send")(function* (world: World, form: Record<string, string>) {
  return yield* world.request("http://umail.test/mail/compose", {
    method: "POST",
    redirect: "manual",
    headers: operatorCookieHeaders(world.sessionCookie, {
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: new URLSearchParams(form).toString(),
  });
});

const REQUEST_ID = "3f0c9a8e-5b1d-4c2a-9e7f-0a1b2c3d4e5f";

function jobIdOf(response: Response): string {
  return /^\/mail\/sent\/(.+)$/u.exec(response.headers.get("location") ?? "")?.[1] ?? "";
}

describe("compose pages", () => {
  it.effect("sends a new message as AgentMail web, once per request id, and shows its status", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");

      const form = yield* page(world, "/mail/compose");
      expect(form.status).toBe(200);
      expect(form.body).toContain(`value="${inbox.id}"`);
      expect(form.body).toMatch(/name="requestId" value="[0-9a-f-]{36}"/u);

      const fields = {
        requestId: REQUEST_ID,
        fromAddressId: inbox.id,
        to: "anna@example.net",
        cc: "",
        subject: "Hello",
        text: "Hi Anna",
      };
      const sent = yield* send(world, fields);
      expect(sent.status).toBe(303);
      const jobId = jobIdOf(sent);

      const job = yield* world.account.getOutboundJob(jobId, { kind: "operator" });
      expect(job?.requester).toEqual({
        kind: "operator",
        clientId: "umail-web",
        label: "AgentMail web",
      });
      expect(job?.state).toBe("ready");

      const again = yield* send(world, fields);
      expect(jobIdOf(again)).toBe(jobId);

      const status = yield* page(world, `/mail/sent/${jobId}`);
      expect(status.body).toContain("Queued");
      expect(status.body).toContain(`href="/mail/threads/${job?.threadId}"`);
    }),
  );

  it.effect("re-renders an invalid recipient with its error and the typed message", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");

      const response = yield* send(world, {
        requestId: REQUEST_ID,
        fromAddressId: inbox.id,
        to: "anna@example.net, nobody",
        subject: "Kept <subject>",
        text: "Kept body",
      });
      const body = yield* readText(response);

      expect(response.status).toBe(400);
      expect(body).toContain("“nobody” is not an email address.");
      expect(body).toContain('value="anna@example.net, nobody"');
      expect(body).toContain('value="Kept &lt;subject&gt;"');
      expect(body).toContain(">Kept body</textarea>");
    }),
  );

  it.effect("keeps the typed reply when the store refuses the send", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      yield* seedInboundMessage(world, inbox.id, { id: "m-parent", subject: "Plans" });
      yield* world.account.patchAddress(inbox.id, { active: false }, "2026-01-03T00:00:00.000Z");

      const response = yield* send(world, {
        requestId: REQUEST_ID,
        reply: "m-parent",
        mode: "reply",
        subject: "Re: Plans",
        text: "Typed reply",
      });
      const body = yield* readText(response);

      expect(response.status).toBe(400);
      expect(body).toContain(
        `Nothing was sent. Mailbox ${inbox.id} (inbox@umail.example.com) is inactive.`,
      );
      expect(body).toContain(">Typed reply</textarea>");
    }),
  );

  it.effect("replies to all from the parent's mailbox with the recipients MCP would use", () =>
    Effect.gen(function* () {
      const world = yield* createWorld();
      const inbox = yield* seedMailbox(world, "inbox");
      yield* seedInboundMessage(world, inbox.id, {
        id: "m-parent",
        subject: "Plans",
        from: "sender@example.com",
        to: ["inbox@umail.example.com", "other@example.com"],
        cc: ["copy@example.com"],
      });

      const form = yield* page(world, "/mail/compose?reply=m-parent&mode=reply-all");
      expect(form.status).toBe(200);
      expect(form.body).toContain('value="Re: Plans"');
      for (const address of ["sender@example.com", "other@example.com", "copy@example.com"]) {
        expect(form.body).toContain(address);
      }

      const sent = yield* send(world, {
        requestId: REQUEST_ID,
        reply: "m-parent",
        mode: "reply-all",
        subject: "Re: Plans",
        text: "Count me in",
      });
      expect(sent.status).toBe(303);
      const job = yield* world.account.getOutboundJob(jobIdOf(sent), { kind: "operator" });
      const message = yield* world.account.getMessageSummary(job?.messageId ?? "", "all");

      expect(message?.mailboxId).toBe(inbox.id);
      expect(message?.to.map((contact) => contact.address)).toEqual(["sender@example.com"]);
      expect(message?.cc.map((contact) => contact.address)).toEqual([
        "other@example.com",
        "copy@example.com",
      ]);
    }),
  );
});
