import type * as Runtime from "@cloudflare/workers-types";
import { describe, expect, it } from "@effect/vitest";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import {
  cloudflareEmailSender,
  materializeProviderMail,
  toSendEmailMessage,
} from "../../src/mail/email-sender.ts";
import type { OutboundMail } from "../../src/mail/email-sender.ts";
import { FakeMailHtmlPolicy } from "./fakes.ts";

const STORED =
  '<p>html body</p><img data-umail-remote-src="https://tracker.example/pixel">' as const;

describe("provider mail mapping", () => {
  it.effect(
    "materializes the canonical body with the configured application URL at the provider boundary",
    () =>
      Effect.gen(function* () {
        const htmlPolicy = new FakeMailHtmlPolicy();
        const applicationUrl = new URL("https://preview.umail.example.com");
        const mail: OutboundMail = {
          from: { email: "inbox@umail.example.com", name: "Inbox" },
          replyTo: { email: "inbox@umail.example.com", name: "Inbox" },
          to: ["alice@example.com"],
          cc: [],
          subject: "Hello",
          text: "plain",
          html: STORED,
          inReplyTo: null,
          references: null,
        };

        const providerMail = yield* materializeProviderMail(htmlPolicy, applicationUrl, mail);

        expect(providerMail.html).toBe(STORED);
      }),
  );

  it("serializes named From and Reply-To, string To/CC, and threading headers", () => {
    const mail: OutboundMail = {
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
    const mail: OutboundMail = {
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
  it.effect("captures each event's native binding and preserves its method receiver", () =>
    Effect.gen(function* () {
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

      const firstSender = yield* constructSender(client, testRuntimeContext("first-event"));
      const secondSender = yield* constructSender(client, testRuntimeContext("second-event"));

      expect(yield* firstSender.send(MAIL)).toEqual({
        kind: "accepted",
        providerMessageId: "<first@example.com>",
        rfcMessageId: "<first@example.com>",
      });
      expect(yield* secondSender.send(MAIL)).toEqual({
        kind: "accepted",
        providerMessageId: "<second@example.com>",
        rfcMessageId: "<second@example.com>",
      });
      expect(client.resolvedContexts).toEqual(["first-event", "second-event"]);
      expect(firstBinding.messages).toHaveLength(1);
      expect(secondBinding.messages).toHaveLength(1);
    }),
  );

  it.effect(
    "rejects known provider codes, including rate limits, and leaves the rest unknown",
    () =>
      Effect.gen(function* () {
        const binding = new RecordingSendEmail({
          kind: "failed",
          error: { code: "E_RECIPIENT_SUPPRESSED", message: "suppressed" },
        });
        const client = new ContextualSendClient(new Map([["provider-event", binding]]));
        const sender = yield* constructSender(client, testRuntimeContext("provider-event"));

        expect(yield* sender.send(MAIL)).toEqual({
          kind: "rejected",
          failureDetail: "E_RECIPIENT_SUPPRESSED: suppressed",
        });

        binding.next = {
          kind: "failed",
          error: { code: "E_VALIDATION_ERROR", message: "bad sender" },
        };
        expect(yield* sender.send(MAIL)).toEqual({
          kind: "rejected",
          failureDetail: "E_VALIDATION_ERROR: bad sender",
        });

        binding.next = {
          kind: "failed",
          error: { code: "E_RATE_LIMIT_EXCEEDED", message: "too many sends" },
        };
        expect(yield* sender.send(MAIL)).toEqual({
          kind: "rejected",
          failureDetail: "E_RATE_LIMIT_EXCEEDED: too many sends",
        });

        // A recipient server's rejection may be partial, so it is not proof of "not sent".
        binding.next = {
          kind: "failed",
          error: { code: "E_DELIVERY_FAILED", message: "550 mailbox unavailable" },
        };
        expect(yield* sender.send(MAIL)).toEqual({
          kind: "unknown",
          failureDetail: "E_DELIVERY_FAILED: 550 mailbox unavailable",
        });

        // A binding that throws instead of rejecting is classified the same way.
        binding.next = {
          kind: "throws",
          error: { code: "E_FIELD_MISSING", message: "missing subject" },
        };
        expect(yield* sender.send(MAIL)).toEqual({
          kind: "rejected",
          failureDetail: "E_FIELD_MISSING: missing subject",
        });

        // An unrecognized failure keeps its message, bounded and without the stack.
        binding.next = { kind: "failed", error: new Error(`connection lost ${"x".repeat(400)}`) };
        const unknown = yield* sender.send(MAIL);
        expect(unknown).toMatchObject({
          kind: "unknown",
          failureDetail: expect.stringMatching(/^connection lost x+$/),
        });
        expect(unknown.kind === "unknown" && unknown.failureDetail?.length).toBe(300);
      }),
  );
});

type NativeSendBehavior =
  | { readonly kind: "accepted"; readonly messageId: string }
  | { readonly kind: "failed"; readonly error: NativeSendError }
  | { readonly kind: "throws"; readonly error: NativeSendError };

type NativeSendError = Error | { readonly code: string; readonly message: string };

class RecordingSendEmail implements Runtime.SendEmail {
  readonly messages: Array<Runtime.EmailMessage | Runtime.EmailMessageBuilder> = [];
  next: NativeSendBehavior;

  constructor(next: NativeSendBehavior) {
    this.next = next;
  }

  send(message: Runtime.EmailMessage): Promise<Runtime.EmailSendResult>;
  send(builder: Runtime.EmailMessageBuilder): Promise<Runtime.EmailSendResult>;
  send(
    message: Runtime.EmailMessage | Runtime.EmailMessageBuilder,
  ): Promise<Runtime.EmailSendResult> {
    this.messages.push(message);
    if (this.next.kind === "throws") {
      throw this.next.error;
    }
    if (this.next.kind === "failed") {
      return Promise.reject(this.next.error);
    }
    return Promise.resolve({ messageId: this.next.messageId });
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

  // Fails like alchemy's binding client: a rejection or a throw becomes a SendEmailError.
  send(message: Cloudflare.Email.SendEmailMessage) {
    return this.raw.pipe(
      Effect.flatMap((binding) =>
        Effect.tryPromise({
          try: () => binding.send(message),
          catch: (error) =>
            new Cloudflare.Email.SendEmailError({ message: String(error), cause: error }),
        }),
      ),
    );
  }

  sendRaw(_message: Runtime.EmailMessage) {
    return Effect.die(new Error("the sender never sends raw messages"));
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
  return cloudflareEmailSender(client).pipe(Effect.provideService(Alchemy.RuntimeContext, context));
}
