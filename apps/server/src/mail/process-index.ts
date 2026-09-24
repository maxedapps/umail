import type { Attachment, Email } from "postal-mime";
import PostalMime from "postal-mime";
import type {
  AcceptInboundInput,
  AccountMailContact,
  MessageAttachmentWrite,
  ReceiptPolicyError,
} from "../account/domain.ts";
import type { AccountStoreError } from "../account/errors.ts";
import type { AccountStoreRpc } from "../account/worker.ts";
import {
  normalizeRfcMessageId,
  parseExternalMailAddress,
  parseUtcInstant,
} from "@umail/api-contract";
import type { MailHtmlPolicy, StoredMailHtml } from "@umail/mail-content";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { inboundAttachmentId, type InboundMessageId } from "./archive.ts";
import {
  attachmentObjectKey,
  INBOUND_MIME_LIMITS,
  MAX_ATTACHMENTS,
  MAX_PERSISTED_MESSAGE_BYTES,
  normalizeContentId,
  sanitizeFilename,
  utf8ByteLength,
} from "./policy.ts";

export class IndexFailure extends Schema.TaggedError<IndexFailure>()("IndexFailure", {
  reason: Schema.String,
}) {}

// The slice of alchemy's R2 bucket client and the AccountStore that indexing uses.
export type IndexDeps<R> = {
  readonly archive: {
    get(
      key: string,
    ): Effect.Effect<{ arrayBuffer(): Effect.Effect<ArrayBuffer, Error> } | null, Error, R>;
    put(key: string, value: Uint8Array): Effect.Effect<unknown, Error, R>;
  };
  readonly account: Pick<
    AccountStoreRpc,
    "getInboundReceipt" | "getAddressByMailbox" | "acceptInbound" | "failInboundReceiptPolicy"
  >;
  readonly htmlPolicy: MailHtmlPolicy;
  readonly nowIso: string;
};

// Success acks the queue message and any failure retries it. A receipt that is still `ready` once
// the queue gives up is redriven by Recovery.
export const indexReceipt = <R>(
  receiptId: string,
  deps: IndexDeps<R>,
): Effect.Effect<void, Error | AccountStoreError, R> =>
  Effect.gen(function* () {
    const receipt = yield* deps.account.getInboundReceipt(receiptId);
    if (receipt === null) {
      return yield* new IndexFailure({ reason: "receipt_missing" });
    }
    if (receipt.workState !== "ready") {
      return;
    }
    const address = yield* deps.account.getAddressByMailbox(receipt.envelopeTo);
    if (address === null) {
      return yield* new IndexFailure({ reason: "address_missing" });
    }
    const object = yield* deps.archive.get(receipt.rawKey);
    if (object === null) {
      return yield* new IndexFailure({ reason: "raw_missing" });
    }
    const raw = yield* object.arrayBuffer();

    const prepared = yield* prepareInbound(
      raw,
      {
        messageId: receiptId,
        mailboxId: address.id,
        occurredAt: receipt.receivedAt,
        nowIso: deps.nowIso,
      },
      deps.htmlPolicy,
    );
    if (prepared.kind === "policy_failed") {
      yield* deps.account.failInboundReceiptPolicy({ receiptId, reason: prepared.reason });
      return yield* Effect.logWarning("Inbound message failed content policy").pipe(
        Effect.annotateLogs({ receiptId, reason: prepared.reason }),
      );
    }
    // Attachment keys are content-addressed, so a retried or concurrent run rewrites the same bytes.
    for (const attachment of prepared.attachments) {
      yield* deps.archive.put(attachment.r2Key, attachment.bytes);
    }
    // A conflict means another delivery of this receipt already stored the message.
    yield* deps.account
      .acceptInbound(prepared.input)
      .pipe(Effect.catchTag("MessageConflictError", () => Effect.void));
  });

export type InboundTarget = {
  readonly messageId: string;
  readonly mailboxId: string;
  readonly occurredAt: string;
  readonly nowIso: string;
};

type PreparedAttachment = MessageAttachmentWrite & { readonly bytes: Uint8Array };

export type PreparedInbound =
  | {
      readonly kind: "ready";
      readonly input: AcceptInboundInput;
      readonly attachments: ReadonlyArray<PreparedAttachment>;
    }
  | { readonly kind: "policy_failed"; readonly reason: ReceiptPolicyError };

// Turns raw MIME into the AccountStore write. It touches no storage; a sanitizer failure keeps
// the message and drops only its HTML.
export const prepareInbound = (
  raw: ArrayBuffer,
  target: InboundTarget,
  htmlPolicy: MailHtmlPolicy,
): Effect.Effect<PreparedInbound> =>
  Effect.gen(function* () {
    const parsed = yield* parseMime(raw);
    if (parsed.kind === "failure") {
      return policyFailure(parsed.reason);
    }
    const email = parsed.email;
    if (email.attachments.some((attachment) => attachment.rfc822DepthExceeded === true)) {
      return policyFailure("rfc822_depth");
    }
    if (email.attachments.length > MAX_ATTACHMENTS) {
      return policyFailure("attachment_cap");
    }

    const messageId = target.messageId as InboundMessageId;
    const attachments = normalizeAttachments(messageId, email.attachments);
    const html = yield* sanitizeHtml(email.html, messageId, attachments, htmlPolicy);
    const text = email.text ?? "";
    const input = {
      messageId,
      mailboxId: target.mailboxId,
      rfcMessageId: email.messageId === undefined ? null : normalizeRfcMessageId(email.messageId),
      inReplyToHeader: email.inReplyTo ?? null,
      referencesHeader: email.references ?? null,
      occurredAt: target.occurredAt,
      parsedDate: email.date === undefined ? null : parseUtcInstant(email.date),
      nowIso: target.nowIso,
      subject: email.subject ?? null,
      textBody: text.length === 0 ? null : text,
      htmlBody: html.body,
      hasRemoteImages: html.hasRemoteImages,
      from: parseMailContacts(email.from === undefined ? undefined : [email.from]),
      replyTo: parseMailContacts(email.replyTo),
      to: parseMailContacts(email.to),
      cc: parseMailContacts(email.cc),
      attachments: attachments.map(({ bytes: _bytes, ...attachment }) => attachment),
    } satisfies AcceptInboundInput;
    if (persistedByteLength(input) > MAX_PERSISTED_MESSAGE_BYTES) {
      return policyFailure("message_budget");
    }
    return { kind: "ready", input, attachments } as const;
  });

function policyFailure(reason: ReceiptPolicyError): PreparedInbound {
  return { kind: "policy_failed", reason };
}

type StoredHtml = StoredMailHtml | { readonly body: null; readonly hasRemoteImages: false };

function sanitizeHtml(
  html: string | undefined,
  messageId: InboundMessageId,
  attachments: ReadonlyArray<PreparedAttachment>,
  htmlPolicy: MailHtmlPolicy,
): Effect.Effect<StoredHtml> {
  const textOnly = { body: null, hasRemoteImages: false } as const;
  if (html === undefined || html.length === 0) {
    return Effect.succeed(textOnly);
  }
  const sanitization = {
    messageId,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      contentId: attachment.contentId,
      mimeType: attachment.mimeType,
    })),
  };
  return htmlPolicy
    .sanitizeForStorage(html, sanitization)
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("HTML sanitizer failed; indexing the message as text only").pipe(
          Effect.annotateLogs({ messageId, reason: error.reason }),
          Effect.as(textOnly),
        ),
      ),
    );
}

type MimeParseOutcome =
  | { readonly kind: "success"; readonly email: Email }
  | { readonly kind: "failure"; readonly reason: ReceiptPolicyError };

function parseMime(raw: ArrayBuffer): Effect.Effect<MimeParseOutcome> {
  return Effect.tryPromise({
    try: () =>
      PostalMime.parse(raw, {
        attachmentEncoding: "arraybuffer",
        ...INBOUND_MIME_LIMITS,
      }),
    catch: (error) => mimeFailureReason(error),
  }).pipe(
    Effect.match({
      onFailure: (reason) => ({ kind: "failure", reason }) as const,
      onSuccess: (email) => ({ kind: "success", email }) as const,
    }),
  );
}

function mimeFailureReason(error: unknown): ReceiptPolicyError {
  if (error instanceof Error && isMimeBudgetMessage(error.message)) {
    return "mime_budget";
  }
  return "parse_failed";
}

function isMimeBudgetMessage(message: string): boolean {
  return (
    message.startsWith("Maximum MIME line ") ||
    message.startsWith("Maximum MIME part count ") ||
    message.startsWith("Maximum raw size of ") ||
    message.startsWith("Maximum decoded size of ") ||
    message.startsWith("Maximum text expansion of ") ||
    message.startsWith("Maximum HTML size of ") ||
    message.startsWith("Maximum References size of ")
  );
}

function persistedByteLength(input: AcceptInboundInput): number {
  const strings = [
    input.subject,
    input.textBody,
    input.htmlBody,
    input.rfcMessageId,
    input.inReplyToHeader,
    input.referencesHeader,
  ];
  let total = 0;
  for (const value of strings) {
    if (typeof value === "string") total += utf8ByteLength(value);
  }
  const contacts = [
    ...(input.from ?? []),
    ...(input.replyTo ?? []),
    ...(input.to ?? []),
    ...(input.cc ?? []),
  ];
  for (const contact of contacts) {
    total += utf8ByteLength(contact.address);
    if (contact.displayName !== null) total += utf8ByteLength(contact.displayName);
  }
  return total;
}

type MimeAddress = {
  readonly address?: string | undefined;
  readonly name?: string | undefined;
  readonly group?: ReadonlyArray<MimeAddress> | undefined;
};

function parseMailContacts(
  addresses: ReadonlyArray<MimeAddress> | undefined,
): ReadonlyArray<AccountMailContact> {
  if (addresses === undefined) {
    return [];
  }
  const contacts: Array<AccountMailContact> = [];
  for (const address of flattenMimeAddresses(addresses)) {
    const raw = address.address;
    if (raw === undefined) {
      continue;
    }
    const parsed = parseExternalMailAddress(raw);
    if (parsed.kind === "invalid") {
      continue;
    }
    const displayName =
      address.name === undefined || address.name.length === 0 ? null : address.name;
    contacts.push({ address: parsed.address, displayName });
  }
  return contacts;
}

function flattenMimeAddresses(addresses: ReadonlyArray<MimeAddress>): ReadonlyArray<MimeAddress> {
  const flattened: Array<MimeAddress> = [];
  for (const address of addresses) {
    if (address.group === undefined) {
      flattened.push(address);
      continue;
    }
    for (const member of address.group) {
      flattened.push(member);
    }
  }
  return flattened;
}

function normalizeAttachments(
  messageId: InboundMessageId,
  attachments: ReadonlyArray<Attachment>,
): ReadonlyArray<PreparedAttachment> {
  const normalized: PreparedAttachment[] = [];
  for (const [position, attachment] of attachments.entries()) {
    const bytes = attachmentBytes(attachment.content);
    const disposition = attachment.disposition;
    normalized.push({
      id: inboundAttachmentId(messageId, position),
      position,
      filename: sanitizeFilename(attachment.filename),
      mimeType: attachment.mimeType.length === 0 ? "application/octet-stream" : attachment.mimeType,
      size: bytes.byteLength,
      r2Key: attachmentObjectKey(messageId, position),
      contentId:
        attachment.contentId === undefined ? null : normalizeContentId(attachment.contentId),
      disposition,
      isInline: disposition === "inline" || attachment.related === true,
      bytes,
    });
  }
  return normalized;
}

function attachmentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new TextEncoder().encode(content);
}
