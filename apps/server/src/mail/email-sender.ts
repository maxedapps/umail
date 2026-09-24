import type * as Alchemy from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { normalizeRfcMessageId } from "@umail/api-contract";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { MailHtmlPolicy, MailHtmlPolicyError, StoredMailHtml } from "./html-policy.ts";
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
  readonly html: StoredMailHtml | null;
  readonly inReplyTo: string | null;
  readonly references: string | null;
};

// The mail exactly as the provider receives it: stored HTML already materialized.
export type ProviderOutboundMail = Omit<OutboundMail, "html"> & {
  readonly html: string | null;
};

export interface EmailSender {
  send(mail: ProviderOutboundMail): Effect.Effect<CompleteAttemptOutcome>;
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

// Codes that prove the provider did not deliver the mail. Anything else may have been sent, so it
// settles `unknown` and is never retried.
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
    return Effect.succeed({ ...mail, html: null });
  }
  return htmlPolicy
    .materializeRemoteImages({ body: mail.html.body, applicationUrl })
    .pipe(Effect.map((html) => ({ ...mail, html })));
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

export function classifyProviderFailure(cause: unknown): CompleteAttemptOutcome {
  const code = providerErrorCode(cause);
  if (code !== null && REJECTED_CODES.has(code)) {
    return { kind: "rejected", failureDetail: code };
  }
  return { kind: "unknown" };
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

export function cloudflareEmailSender(
  client: Cloudflare.Email.SendClient,
): Effect.Effect<EmailSender, never, Alchemy.RuntimeContext> {
  return Effect.gen(function* () {
    const binding = yield* client.raw;
    return {
      send: (mail) =>
        Effect.promise(() =>
          binding.send(toSendEmailMessage(mail)).then(
            (result): CompleteAttemptOutcome => ({
              kind: "accepted",
              providerMessageId: result.messageId,
              rfcMessageId: normalizeRfcMessageId(result.messageId),
            }),
            classifyProviderFailure,
          ),
        ),
    } satisfies EmailSender;
  });
}
