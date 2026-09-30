import type * as Alchemy from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { normalizeRfcMessageId } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { MailHtmlPolicy, MailHtmlPolicyError } from "./html-policy.ts";
import type { CompleteAttemptOutcome } from "../account/domain.ts";

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
  readonly html: string | null;
  readonly inReplyTo: string | null;
  readonly references: string | null;
};

export interface EmailSender {
  send(mail: OutboundMail): Effect.Effect<CompleteAttemptOutcome>;
}

// Codes that prove the provider did not deliver the mail. Anything else may have been sent, so it
// settles `unknown` and is never retried. E_DELIVERY_FAILED is a rejection by a recipient's server,
// which may be partial across recipients, so it is `unknown` too.
const REJECTED_CODES = new Set([
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
  "E_RATE_LIMIT_EXCEEDED",
  "E_RECIPIENT_SUPPRESSED",
  "E_DAILY_LIMIT_EXCEEDED",
]);

const ProviderErrorFields = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

const ERROR_CODE_PATTERN = /E_[A-Z0-9_]+/;

// Stored HTML keeps remote images inert; the provider gets them as live sources.
export function materializeProviderMail(
  htmlPolicy: MailHtmlPolicy,
  applicationUrl: URL,
  mail: OutboundMail,
): Effect.Effect<OutboundMail, MailHtmlPolicyError> {
  if (mail.html === null) {
    return Effect.succeed(mail);
  }
  return htmlPolicy
    .materializeRemoteImages({ body: mail.html, applicationUrl })
    .pipe(Effect.map((html) => ({ ...mail, html })));
}

export function toSendEmailMessage(mail: OutboundMail): Cloudflare.Email.SendEmailMessage {
  const message: Cloudflare.Email.SendEmailMessage = {
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

// Both outcomes keep what the provider said: its code and a short message, without a stack.
function classifyProviderFailure(cause: unknown): CompleteAttemptOutcome {
  const code = providerErrorCode(cause);
  const failureDetail = providerFailureDetail(cause, code);
  if (code !== null && REJECTED_CODES.has(code)) {
    return { kind: "rejected", failureDetail };
  }
  return { kind: "unknown", failureDetail };
}

function providerFailureDetail(cause: unknown, code: string | null): string {
  const decoded = Schema.decodeUnknownResult(ProviderErrorFields)(cause);
  const message =
    Result.isSuccess(decoded) && decoded.success.message !== undefined
      ? decoded.success.message
      : String(cause);
  const detail = code === null || message.includes(code) ? message : `${code}: ${message}`;
  return detail.slice(0, MAX_FAILURE_DETAIL);
}

const MAX_FAILURE_DETAIL = 300;

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

// The provider reports its code in `code`, or only inside `message` or `name`.
function providerErrorCode(cause: unknown): string | null {
  const decoded = Schema.decodeUnknownResult(ProviderErrorFields)(cause);
  const candidates = Result.isSuccess(decoded)
    ? [decoded.success.code, decoded.success.message, decoded.success.name]
    : [cause];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const matched = ERROR_CODE_PATTERN.exec(candidate);
    if (matched !== null) return matched[0];
  }
  return null;
}

// Each send resolves the binding in the runtime context the sender was built in.
export const cloudflareEmailSender = Effect.fn("cloudflareEmailSender")(function* (
  client: Cloudflare.Email.SendClient,
): Effect.fn.Return<EmailSender, never, Alchemy.RuntimeContext> {
  const context = yield* Effect.context<Alchemy.RuntimeContext>();
  return {
    send: (mail) =>
      client.send(toSendEmailMessage(mail)).pipe(
        Effect.match({
          onFailure: (error) => classifyProviderFailure(error.cause),
          onSuccess: (result): CompleteAttemptOutcome => ({
            kind: "accepted",
            providerMessageId: result.messageId,
            rfcMessageId: normalizeRfcMessageId(result.messageId),
          }),
        }),
        Effect.provideContext(context),
      ),
  } satisfies EmailSender;
});
