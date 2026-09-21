import type * as Runtime from "@cloudflare/workers-types";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  cloudflareEmailSender,
  materializeProviderMail,
  toSendEmailMessage,
} from "../../src/mail/email-sender.ts";
import type { OutboundMail, ProviderOutboundMail } from "../../src/mail/email-sender.ts";
import { FakeMailHtmlPolicy } from "./fakes.ts";

const STORED =
  '<p>html body</p><img data-umail-remote-src="https://tracker.example/pixel">' as const;

describe("provider mail mapping", () => {
  it("materializes the canonical body with the configured application URL at the provider boundary", async () => {
    const htmlPolicy = new FakeMailHtmlPolicy();
    const applicationUrl = new URL("https://preview.umail.example.com");
    const mail: OutboundMail = {
      from: { email: "inbox@umail.example.com", name: "Inbox" },
      replyTo: { email: "inbox@umail.example.com", name: "Inbox" },
      to: ["alice@example.com"],
      cc: [],
      subject: "Hello",
      text: "plain",
      html: { body: STORED, hasRemoteImages: true },
      inReplyTo: null,
      references: null,
    };

    const providerMail = await Effect.runPromise(
      materializeProviderMail(htmlPolicy, applicationUrl, mail),
    );

    expect(providerMail.html).toBe(STORED);
  });

  it("serializes named From and Reply-To, string To/CC, and threading headers", () => {
    const mail: ProviderOutboundMail = {
      from: { email: "inbox@umail.example.com", name: "Inbox" },
      replyTo: { email: "inbox@umail.example.com", name: "Inbox" },
      to: ["alice@example.com"],
      cc: ["cc@example.com"],
      subject: "Hello",
      text: "plain",
      html: "<p>html</p>",
      inReplyTo: "<parent@example.com>",
      references: "<root@example.com> <parent@example.com>",
    };
    expect(toSendEmailMessage(mail)).toEqual({
      from: { email: "inbox@umail.example.com", name: "Inbox" },
      replyTo: { email: "inbox@umail.example.com", name: "Inbox" },
      to: ["alice@example.com"],
      cc: ["cc@example.com"],
      subject: "Hello",
      text: "plain",
      html: "<p>html</p>",
      headers: {
        "In-Reply-To": "<parent@example.com>",
        References: "<root@example.com> <parent@example.com>",
      },
    });
  });

  it("omits empty CC and threading headers", () => {
    const mail: ProviderOutboundMail = {
      from: { email: "inbox@umail.example.com", name: null },
      replyTo: { email: "inbox@umail.example.com", name: null },
      to: ["alice@example.com"],
      cc: [],
      subject: "Hello",
      text: "plain",
      html: null,
      inReplyTo: null,
      references: null,
    };
    expect(toSendEmailMessage(mail)).toEqual({
      from: { email: "inbox@umail.example.com", name: "" },
      replyTo: { email: "inbox@umail.example.com", name: "" },
      to: ["alice@example.com"],
      subject: "Hello",
      text: "plain",
    });
  });
});

const APPLICATION_URL = new URL("https://umail.example.com");
const MAIL = {
  from: { email: "inbox@umail.example.com", name: "Inbox" },
  replyTo: { email: "inbox@umail.example.com", name: "Inbox" },
  to: ["recipient@example.com"],
  cc: [],
  subject: "Context-bound delivery",
  text: "body",
  html: null,
  inReplyTo: null,
  references: null,
} satisfies OutboundMail;

describe("Cloudflare email sender", () => {
  it("captures each event's native binding and preserves its method receiver", async () => {
    const firstBinding = new RecordingSendEmail({
      kind: "accepted",
      messageId: "<first@example.com>",
    });
    const secondBinding = new RecordingSendEmail({
      kind: "accepted",
      messageId: "<second@example.com>",
    });
    const client = new ContextualSendClient(
      new Map([
        ["first-event", firstBinding],
        ["second-event", secondBinding],
      ]),
    );

    const firstSender = await constructSender(client, testRuntimeContext("first-event"));
    const secondSender = await constructSender(client, testRuntimeContext("second-event"));
    expect(client.resolvedContexts).toEqual(["first-event", "second-event"]);

    expect(await Effect.runPromise(firstSender.send(MAIL))).toEqual({
      kind: "accepted",
      providerMessageId: "<first@example.com>",
      rfcMessageId: "<first@example.com>",
    });
    expect(await Effect.runPromise(secondSender.send(MAIL))).toEqual({
      kind: "accepted",
      providerMessageId: "<second@example.com>",
      rfcMessageId: "<second@example.com>",
    });
    expect(client.resolvedContexts).toEqual(["first-event", "second-event"]);
    expect(firstBinding.messages).toHaveLength(1);
    expect(secondBinding.messages).toHaveLength(1);
  });

  it("preserves rejected, pre-dispatch, and unknown provider outcomes", async () => {
    const binding = new RecordingSendEmail({
      kind: "failed",
      error: { code: "E_RECIPIENT_SUPPRESSED", message: "suppressed" },
    });
    const client = new ContextualSendClient(new Map([["provider-event", binding]]));
    const sender = await constructSender(client, testRuntimeContext("provider-event"));

    expect(await Effect.runPromise(sender.send(MAIL))).toEqual({
      kind: "rejected",
      detail: "suppressed",
    });

    binding.next = {
      kind: "failed",
      error: { code: "E_VALIDATION_ERROR", message: "bad sender" },
    };
    expect(await Effect.runPromise(sender.send(MAIL))).toEqual({
      kind: "pre_dispatch",
      detail: "bad sender",
    });

    binding.next = { kind: "failed", error: new Error("connection lost") };
    expect(await Effect.runPromise(sender.send(MAIL))).toEqual({
      kind: "unknown",
      detail: "connection lost",
    });
  });
});

type NativeSendBehavior =
  | { readonly kind: "accepted"; readonly messageId: string }
  | {
      readonly kind: "failed";
      readonly error: Error | { readonly code: string; readonly message: string };
    };

class RecordingSendEmail implements Runtime.SendEmail {
  readonly messages: Array<Runtime.EmailMessage | Runtime.EmailMessageBuilder> = [];
  next: NativeSendBehavior;

  constructor(next: NativeSendBehavior) {
    this.next = next;
  }

  send(message: Runtime.EmailMessage): Promise<Runtime.EmailSendResult>;
  send(builder: Runtime.EmailMessageBuilder): Promise<Runtime.EmailSendResult>;
  async send(
    message: Runtime.EmailMessage | Runtime.EmailMessageBuilder,
  ): Promise<Runtime.EmailSendResult> {
    this.messages.push(message);
    if (this.next.kind === "failed") {
      throw this.next.error;
    }
    return { messageId: this.next.messageId };
  }
}

class ContextualSendClient implements Cloudflare.Email.SendClient {
  readonly resolvedContexts: string[] = [];
  readonly raw = Alchemy.RuntimeContext.pipe(
    Effect.map((context) => {
      this.resolvedContexts.push(context.id);
      const binding = this.bindings.get(context.id);
      if (binding === undefined) {
        throw new Error(`missing native binding for ${context.id}`);
      }
      return binding;
    }),
  );

  private readonly bindings: ReadonlyMap<string, Runtime.SendEmail>;

  constructor(bindings: ReadonlyMap<string, Runtime.SendEmail>) {
    this.bindings = bindings;
  }

  send(message: Cloudflare.Email.SendEmailMessage) {
    return this.raw.pipe(Effect.flatMap((binding) => Effect.promise(() => binding.send(message))));
  }

  sendRaw(message: Runtime.EmailMessage) {
    return this.raw.pipe(Effect.flatMap((binding) => Effect.promise(() => binding.send(message))));
  }
}

function testRuntimeContext(id: string) {
  return {
    Type: "test",
    id,
    env: { TEST_EVENT_ID: id },
    get: <Value>(_key: string): Effect.Effect<Value | undefined> =>
      Effect.die(new Error("test runtime context has no named values")),
    set: (key: string) => Effect.succeed(key),
  } satisfies Alchemy.BaseRuntimeContext;
}

function constructSender(client: Cloudflare.Email.SendClient, context: Alchemy.BaseRuntimeContext) {
  return Effect.runPromise(
    cloudflareEmailSender(client, new FakeMailHtmlPolicy(), APPLICATION_URL).pipe(
      Effect.provideService(Alchemy.RuntimeContext, context),
    ),
  );
}
