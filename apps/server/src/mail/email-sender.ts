import type * as Runtime from "@cloudflare/workers-types";
import type * as Alchemy from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import type { MailContact } from "@umail/api-contract";
import { NormalizedRfcMessageId, normalizeRfcMessageId } from "@umail/api-contract";
import { MailHtmlPolicyError, type MailHtmlPolicy, type StoredMailHtml } from "@umail/mail-content";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type NamedMailboxSender = {
  readonly email: string;
  readonly name: string | null;
};

export type OutboundMail = {
  readonly from: NamedMailboxSender;
  readonly replyTo: NamedMailboxSender;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly text: string | null;
  readonly html: StoredMailHtml | null;
  readonly inReplyTo: string | null;
  readonly references: string | null;
};

export type ProviderOutboundMail = {
  readonly from: NamedMailboxSender;
  readonly replyTo: NamedMailboxSender;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly inReplyTo: string | null;
  readonly references: string | null;
};

export const ProviderSendAccepted = Schema.Struct({
  kind: Schema.Literal("accepted"),
  providerMessageId: Schema.String.check(Schema.isMinLength(1)),
  rfcMessageId: Schema.NullOr(NormalizedRfcMessageId),
});
export type ProviderSendAccepted = typeof ProviderSendAccepted.Type;

export const ProviderSendRejected = Schema.Struct({
  kind: Schema.Literal("rejected"),
  detail: Schema.String,
});
export type ProviderSendRejected = typeof ProviderSendRejected.Type;

export const ProviderSendUnknown = Schema.Struct({
  kind: Schema.Literal("unknown"),
  detail: Schema.String,
});
export type ProviderSendUnknown = typeof ProviderSendUnknown.Type;

export const ProviderSendPreDispatch = Schema.Struct({
  kind: Schema.Literal("pre_dispatch"),
  detail: Schema.String,
});
export type ProviderSendPreDispatch = typeof ProviderSendPreDispatch.Type;

export const ProviderSendOutcome = Schema.Union([
  ProviderSendAccepted,
  ProviderSendRejected,
  ProviderSendUnknown,
  ProviderSendPreDispatch,
]);
export type ProviderSendOutcome = typeof ProviderSendOutcome.Type;

export interface EmailSender {
  send(mail: OutboundMail): Effect.Effect<ProviderSendOutcome>;
}

export type ProviderSendMessage = {
  from: { email: string; name: string };
  replyTo: { email: string; name: string };
  to: Array<string>;
  subject: string;
  cc?: Array<string>;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
};

const PRE_DISPATCH_CODES = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
]);

const REJECTED_CODES = new Set([
  "E_RECIPIENT_SUPPRESSED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_DELIVERY_FAILED",
]);

const ProviderErrorFields = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

const ERROR_CODE_PATTERN = /E_[A-Z0-9_]+/;

export function materializeProviderMail(
  htmlPolicy: MailHtmlPolicy,
  applicationUrl: URL,
  mail: OutboundMail,
): Effect.Effect<ProviderOutboundMail, MailHtmlPolicyError> {
  if (mail.html === null) {
    return Effect.succeed({ ...mail, html: null } satisfies ProviderOutboundMail);
  }
  return htmlPolicy
    .materializeRemoteImages({
      body: mail.html.body,
      applicationUrl,
    })
    .pipe(Effect.map((html) => ({ ...mail, html }) satisfies ProviderOutboundMail));
}

export function toSendEmailMessage(mail: ProviderOutboundMail): ProviderSendMessage {
  const message: ProviderSendMessage = {
    from: namedAddress(mail.from),
    replyTo: namedAddress(mail.replyTo),
    to: [...mail.to],
    subject: mail.subject,
  };
  if (mail.cc.length > 0) {
    message.cc = [...mail.cc];
  }
  if (mail.text !== null) {
    message.text = mail.text;
  }
  if (mail.html !== null) {
    message.html = mail.html;
  }
  const headers = threadingHeaders(mail.inReplyTo, mail.references);
  if (headers !== null) {
    message.headers = headers;
  }
  return message;
}

export function classifyProviderFailure(cause: unknown): ProviderSendOutcome {
  const code = providerErrorCode(cause);
  const detail = providerErrorDetail(cause, code);
  if (code !== null && PRE_DISPATCH_CODES.has(code)) {
    return Schema.decodeSync(ProviderSendPreDispatch)({ kind: "pre_dispatch", detail });
  }
  if (code !== null && REJECTED_CODES.has(code)) {
    return Schema.decodeSync(ProviderSendRejected)({ kind: "rejected", detail });
  }
  return Schema.decodeSync(ProviderSendUnknown)({ kind: "unknown", detail });
}

export function optionalRfcMessageId(raw: string): NormalizedRfcMessageId | null {
  return normalizeRfcMessageId(raw);
}

export function recipientAddresses(contacts: ReadonlyArray<MailContact>): ReadonlyArray<string> {
  return contacts.map((contact) => contact.address);
}

function namedAddress(sender: NamedMailboxSender) {
  return {
    email: sender.email,
    name: sender.name === null ? "" : sender.name,
  };
}

function threadingHeaders(
  inReplyTo: string | null,
  references: string | null,
): Record<string, string> | null {
  if (inReplyTo === null && references === null) {
    return null;
  }
  if (inReplyTo !== null && references !== null) {
    return {
      "In-Reply-To": inReplyTo,
      References: references,
    };
  }
  if (inReplyTo !== null) {
    return { "In-Reply-To": inReplyTo };
  }
  return { References: references ?? "" };
}

function providerErrorCode(cause: unknown): string | null {
  const decoded = Schema.decodeUnknownResult(ProviderErrorFields)(cause);
  if (Result.isSuccess(decoded) && decoded.success.code !== undefined) {
    const fromCode = matchErrorCode(decoded.success.code);
    if (fromCode !== null) {
      return fromCode;
    }
  }
  if (Result.isSuccess(decoded) && decoded.success.message !== undefined) {
    const fromMessage = matchErrorCode(decoded.success.message);
    if (fromMessage !== null) {
      return fromMessage;
    }
  }
  if (Result.isSuccess(decoded) && decoded.success.name !== undefined) {
    const fromName = matchErrorCode(decoded.success.name);
    if (fromName !== null) {
      return fromName;
    }
  }
  if (typeof cause === "string") {
    return matchErrorCode(cause);
  }
  return null;
}

function providerErrorDetail(cause: unknown, code: string | null): string {
  const decoded = Schema.decodeUnknownResult(ProviderErrorFields)(cause);
  if (Result.isSuccess(decoded) && decoded.success.message !== undefined) {
    return decoded.success.message;
  }
  if (code !== null) {
    return code;
  }
  return "unclassified_provider_error";
}

function matchErrorCode(raw: string): string | null {
  const matched = ERROR_CODE_PATTERN.exec(raw);
  if (matched === null) {
    return null;
  }
  return matched[0] ?? null;
}

export function cloudflareEmailSender(
  client: Cloudflare.Email.SendClient,
  htmlPolicy: MailHtmlPolicy,
  applicationUrl: URL,
): Effect.Effect<EmailSender, never, Alchemy.RuntimeContext> {
  return Effect.gen(function* () {
    const binding = yield* client.raw;
    return {
      send: (mail) =>
        materializeProviderMail(htmlPolicy, applicationUrl, mail).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.succeed(
                Schema.decodeSync(ProviderSendPreDispatch)({
                  kind: "pre_dispatch",
                  detail: error.reason,
                }),
              ),
            onSuccess: (providerMail) => dispatchProviderMail(binding, providerMail),
          }),
        ),
    } satisfies EmailSender;
  });
}

class ProviderCallFailure extends Schema.TaggedError<ProviderCallFailure>()("ProviderCallFailure", {
  outcome: ProviderSendOutcome,
}) {}

function dispatchProviderMail(
  binding: Runtime.SendEmail,
  providerMail: ProviderOutboundMail,
): Effect.Effect<ProviderSendOutcome> {
  return Effect.tryPromise({
    try: () => binding.send(toSendEmailMessage(providerMail)),
    catch: (cause) => new ProviderCallFailure({ outcome: classifyProviderFailure(cause) }),
  }).pipe(
    Effect.match({
      onFailure: (error) => error.outcome,
      onSuccess: (result) =>
        Schema.decodeSync(ProviderSendAccepted)({
          kind: "accepted",
          providerMessageId: result.messageId,
          rfcMessageId: optionalRfcMessageId(result.messageId),
        }),
    }),
  );
}
