import type { Attachment, Email } from "postal-mime";
import PostalMime from "postal-mime";
import type {
  AcceptInboundInput,
  AcceptMessageResult,
  AccountAddress,
  AccountMailContact,
  ClaimInboundReceiptInput,
  ClaimInboundReceiptResult,
  FailInboundReceiptPolicyInput,
  InboundReceipt,
} from "../account/domain.ts";
import {
  normalizeRfcMessageId,
  parseUtcInstant,
  parseExternalMailAddress,
  parseMailboxAddress,
  type ExternalMailAddress,
  type NormalizedRfcMessageId,
} from "@umail/api-contract";
import type { MailHtmlPolicy } from "@umail/mail-content";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { inboundAttachmentId, type InboundAttachmentId, type InboundMessageId } from "./archive.ts";
import type { ForwardOutcome, IndexPayload } from "./index-payload.ts";
import {
  attachmentObjectKey,
  INBOUND_MIME_LIMITS,
  MAX_ATTACHMENTS,
  MAX_PERSISTED_MESSAGE_BYTES,
  normalizeContentId,
  sanitizeFilename,
  utf8ByteLength,
  type AttachmentObjectKey,
} from "./policy.ts";
import {
  encodeReceiptManifest,
  receiptManifestKey,
  ReceiptManifest,
  withReceiptPolicyFailure,
} from "./archive.ts";

export class ArchiveError extends Schema.TaggedError<ArchiveError>()("ArchiveError", {
  reason: Schema.String,
}) {}

export class IndexFailure extends Schema.TaggedError<IndexFailure>()("IndexFailure", {
  reason: Schema.String,
}) {}

export interface ArchiveStore<R = never> {
  get(key: string): Effect.Effect<ArrayBuffer | null, ArchiveError, R>;
  put(key: string, bytes: Uint8Array): Effect.Effect<void, ArchiveError, R>;
}

export type ProcessingFailureReason =
  | "attachment_cap"
  | "message_budget"
  | "mime_budget"
  | "parse_failed"
  | "rfc822_depth"
  | "sanitize_failed";

export type IndexConsumerAccount = {
  getInboundReceipt(receiptId: string): Effect.Effect<InboundReceipt | null, IndexFailure>;
  getAddressByMailbox(address: string): Effect.Effect<AccountAddress | null, IndexFailure>;
  claimInboundReceipt(
    input: ClaimInboundReceiptInput,
  ): Effect.Effect<ClaimInboundReceiptResult, IndexFailure>;
  acceptInbound(input: AcceptInboundInput): Effect.Effect<AcceptMessageResult, IndexFailure>;
  completeInboundReceipt(receiptId: string): Effect.Effect<InboundReceipt, IndexFailure>;
  failInboundReceiptPolicy(
    input: FailInboundReceiptPolicyInput,
  ): Effect.Effect<InboundReceipt, IndexFailure>;
};

export const consumeIndexReceipt = <R>(
  receiptId: string,
  archive: ArchiveStore<R>,
  htmlPolicy: MailHtmlPolicy,
  account: IndexConsumerAccount,
  nowIso: string,
  claimUntilIso: string,
): Effect.Effect<void, ArchiveError | IndexFailure, R> =>
  Effect.gen(function* () {
    const existing = yield* account.getInboundReceipt(receiptId);
    if (existing === null) {
      return yield* new IndexFailure({ reason: "receipt_missing" });
    }
    if (isFinishedReceiptWork(existing.workState)) {
      return;
    }
    const claimed = yield* account.claimInboundReceipt({
      receiptId,
      nowIso,
      claimUntilIso,
    });
    if (isFinishedReceiptWork(claimed.receipt.workState)) {
      return;
    }
    if (claimed.claimed !== true) {
      return yield* new IndexFailure({ reason: "claimed" });
    }

    const receipt = claimed.receipt;
    const envelopeTo = parseMailboxAddress(receipt.envelopeTo);
    if (envelopeTo.kind === "invalid") {
      yield* persistReceiptManifestFailure(archive, receiptId, "parse_failed");
      yield* account.failInboundReceiptPolicy({ receiptId, reason: "parse_failed" });
      return;
    }
    const address = yield* account.getAddressByMailbox(envelopeTo.address);
    if (address === null) {
      return yield* new IndexFailure({ reason: "address_missing" });
    }

    const raw = yield* archive.get(receipt.rawKey);
    if (raw === null) {
      return yield* new IndexFailure({ reason: "raw_missing" });
    }

    const payload = {
      key: receipt.rawKey,
      digest: receipt.digest,
      envelope: { from: receipt.envelopeFrom, to: envelopeTo.address },
      receivedAt: receipt.receivedAt,
      forwardOutcome: { kind: "none" },
    } satisfies IndexPayload;
    const prepared = yield* prepareIndexedInbound(
      payload,
      address.id,
      receipt.receiptId,
      raw,
      htmlPolicy,
    );
    if (prepared.kind === "policy_failed") {
      yield* persistReceiptManifestFailure(archive, receiptId, prepared.reason);
      yield* account.failInboundReceiptPolicy({ receiptId, reason: prepared.reason });
      return;
    }

    for (const attachment of prepared.plan.attachments) {
      yield* archive.put(attachment.key, attachment.bytes);
    }

    yield* account.acceptInbound(acceptMailInputFromPlan(prepared.plan, nowIso)).pipe(
      Effect.catchIf(
        (error) => error.reason === "duplicate",
        () => Effect.void,
      ),
    );
    yield* account.completeInboundReceipt(receiptId);
  }).pipe(Effect.mapError((error) => mapIndexError(error)));

function isFinishedReceiptWork(state: InboundReceipt["workState"]): boolean {
  return (
    state === "indexed" ||
    state === "policy_failed" ||
    state === "terminal" ||
    state === "operator_reprocess"
  );
}

function acceptMailInputFromPlan(plan: NormalizedInboundPlan, nowIso: string): AcceptInboundInput {
  return {
    messageId: plan.message.id,
    mailboxId: plan.message.addressId,
    rfcMessageId: plan.message.rfcMessageId,
    inReplyToHeader: plan.message.inReplyToHeader,
    referencesHeader: plan.message.referencesHeader,
    occurredAt: plan.message.occurredAt,
    parsedDate: plan.message.parsedDate,
    nowIso,
    subject: plan.message.subject,
    textBody: plan.message.textBody,
    htmlBody: plan.message.htmlBody,
    hasRemoteImages: plan.message.hasRemoteImages,
    from: plan.message.from.map(toAccountMailContact),
    replyTo: plan.message.replyTo.map(toAccountMailContact),
    to: plan.message.to.map(toAccountMailContact),
    cc: plan.message.cc.map(toAccountMailContact),
    attachments: plan.attachments.map((attachment) => ({
      id: attachment.id,
      position: attachment.position,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      r2Key: attachment.key,
      contentId: attachment.contentId,
      disposition: attachment.disposition,
      isInline: attachment.isInline === 1,
    })),
  };
}

type ParsedMailContact = {
  readonly address: ExternalMailAddress;
  readonly displayName: string | null;
};

function toAccountMailContact(contact: ParsedMailContact): AccountMailContact {
  return {
    address: contact.address,
    displayName: contact.displayName,
  };
}

type MimeAddress = {
  readonly address?: string | undefined;
  readonly name?: string | undefined;
  readonly group?: ReadonlyArray<MimeAddress> | undefined;
};

function parseMailContacts(
  addresses: ReadonlyArray<MimeAddress> | undefined,
): ReadonlyArray<ParsedMailContact> {
  if (addresses === undefined) {
    return [];
  }
  const contacts: Array<ParsedMailContact> = [];
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

function mapIndexError(
  error: ArchiveError | IndexFailure | { readonly _tag: string },
): ArchiveError | IndexFailure {
  if (Schema.is(ArchiveError)(error) || Schema.is(IndexFailure)(error)) {
    return error;
  }
  return new IndexFailure({ reason: "sql_failed" });
}

type MimeParseOutcome =
  | { readonly kind: "success"; readonly email: Email }
  | { readonly kind: "failure"; readonly reason: ProcessingFailureReason };

type PreparedInbound =
  | { readonly kind: "plan"; readonly plan: NormalizedInboundPlan }
  | { readonly kind: "policy_failed"; readonly reason: ProcessingFailureReason };

function prepareIndexedInbound(
  payload: IndexPayload,
  addressId: string,
  messageId: string,
  raw: ArrayBuffer,
  htmlPolicy: MailHtmlPolicy,
): Effect.Effect<PreparedInbound> {
  return Effect.gen(function* () {
    const inboundId = inboundMessageIdFromReceipt(messageId);
    const parsed = yield* parseMime(raw);
    if (parsed.kind === "failure") {
      return { kind: "policy_failed", reason: parsed.reason } as const;
    }

    const email = parsed.email;
    if (email.attachments.some((attachment) => attachment.rfc822DepthExceeded === true)) {
      return { kind: "policy_failed", reason: "rfc822_depth" } as const;
    }
    if (email.attachments.length > MAX_ATTACHMENTS) {
      return { kind: "policy_failed", reason: "attachment_cap" } as const;
    }
    if (
      email.references !== undefined &&
      utf8ByteLength(email.references) > INBOUND_MIME_LIMITS.maxReferencesBytes
    ) {
      return { kind: "policy_failed", reason: "mime_budget" } as const;
    }

    const attachments = normalizeAttachments(inboundId, email.attachments);
    const text = email.text ?? "";
    const html = email.html ?? "";
    if (utf8ByteLength(html) > INBOUND_MIME_LIMITS.maxHtmlBytes) {
      return { kind: "policy_failed", reason: "mime_budget" } as const;
    }
    let htmlBody: string | null = null;
    let hasRemoteImages = false;
    if (html.length > 0) {
      const sanitized = yield* Effect.result(
        htmlPolicy.sanitizeForStorage(html, {
          messageId: inboundId,
          attachments: attachments.map((attachment) => ({
            id: attachment.id,
            contentId: attachment.contentId,
            mimeType: attachment.mimeType,
          })),
        }),
      );
      if (Result.isFailure(sanitized)) {
        const reason =
          sanitized.failure.reason === "resource_exhausted" ? "mime_budget" : "sanitize_failed";
        return { kind: "policy_failed", reason } as const;
      }
      htmlBody = sanitized.success.body;
      hasRemoteImages = sanitized.success.hasRemoteImages;
    }

    const indexedAt = DateTime.formatIso(yield* DateTime.now);
    const plan = {
      message: normalizedMessagePlan(
        payload,
        addressId,
        inboundId,
        email,
        text.length === 0 ? null : text,
        htmlBody,
        hasRemoteImages,
        indexedAt,
      ),
      attachments,
    } satisfies NormalizedInboundPlan;
    if (persistedMessageByteLength(plan.message) > MAX_PERSISTED_MESSAGE_BYTES) {
      return { kind: "policy_failed", reason: "message_budget" } as const;
    }
    return { kind: "plan", plan } as const;
  });
}

function inboundMessageIdFromReceipt(receiptId: string): InboundMessageId {
  return receiptId as InboundMessageId;
}

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

function mimeFailureReason(error: unknown): ProcessingFailureReason {
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

function persistReceiptManifestFailure<R>(
  archive: ArchiveStore<R>,
  receiptId: string,
  reason: ProcessingFailureReason,
): Effect.Effect<void, ArchiveError, R> {
  const manifestKey = receiptManifestKey(receiptId);
  return Effect.gen(function* () {
    const bytes = yield* archive.get(manifestKey);
    if (bytes === null) {
      return;
    }
    const decoded = Schema.decodeResult(Schema.fromJsonString(ReceiptManifest))(
      new TextDecoder().decode(bytes),
    );
    if (Result.isFailure(decoded)) {
      return yield* new ArchiveError({ reason: "read_failed" });
    }
    const next = withReceiptPolicyFailure(decoded.success, reason);
    if (next === decoded.success) {
      return;
    }
    yield* archive.put(manifestKey, encodeReceiptManifest(next));
  });
}

type IndexedMessagePlan = {
  readonly id: InboundMessageId;
  readonly addressId: string;
  readonly direction: "inbound";
  readonly rawKey: string;
  readonly digest: string;
  readonly envelopeFrom: string;
  readonly envelopeTo: string;
  readonly subject: string | null;
  readonly parsedDate: string | null;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly hasRemoteImages: boolean;
  readonly occurredAt: string;
  readonly processingState: "indexed";
  readonly processingError: null;
  readonly forwardOutcome: "none" | "success" | "failure";
  readonly forwardDestination: string | null;
  readonly forwardError: string | null;
  readonly rfcMessageId: NormalizedRfcMessageId | null;
  readonly inReplyToHeader: string | null;
  readonly referencesHeader: string | null;
  readonly from: ReadonlyArray<ParsedMailContact>;
  readonly replyTo: ReadonlyArray<ParsedMailContact>;
  readonly to: ReadonlyArray<ParsedMailContact>;
  readonly cc: ReadonlyArray<ParsedMailContact>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type NormalizedInboundPlan = {
  readonly message: IndexedMessagePlan;
  readonly attachments: ReadonlyArray<NormalizedAttachment>;
};

function normalizedMessagePlan(
  payload: IndexPayload,
  addressId: string,
  messageId: InboundMessageId,
  email: Email,
  textBody: string | null,
  htmlBody: string | null,
  hasRemoteImages: boolean,
  indexedAt: string,
): IndexedMessagePlan {
  const forward = forwardColumns(payload.forwardOutcome);
  const from = parseMailContacts(email.from === undefined ? undefined : [email.from]);
  const to = parseMailContacts(email.to);
  const cc = parseMailContacts(email.cc);
  const replyTo = parseMailContacts(email.replyTo);
  return {
    id: messageId,
    addressId,
    direction: "inbound",
    rawKey: payload.key,
    digest: payload.digest,
    envelopeFrom: payload.envelope.from,
    envelopeTo: payload.envelope.to,
    subject: email.subject ?? null,
    parsedDate: email.date === undefined ? null : parseUtcInstant(email.date),
    textBody,
    htmlBody,
    hasRemoteImages,
    occurredAt: payload.receivedAt,
    processingState: "indexed",
    processingError: null,
    forwardOutcome: forward.outcome,
    forwardDestination: forward.destination,
    forwardError: forward.error,
    rfcMessageId: email.messageId === undefined ? null : normalizeRfcMessageId(email.messageId),
    inReplyToHeader: email.inReplyTo ?? null,
    referencesHeader: email.references ?? null,
    from,
    replyTo,
    to,
    cc,
    createdAt: indexedAt,
    updatedAt: indexedAt,
  };
}

function persistedMessageByteLength(message: IndexedMessagePlan): number {
  const strings = [
    message.id,
    message.addressId,
    message.direction,
    message.rawKey,
    message.digest,
    message.envelopeFrom,
    message.envelopeTo,
    message.subject,
    message.parsedDate,
    message.textBody,
    message.htmlBody,
    message.occurredAt,
    message.processingState,
    message.processingError,
    message.forwardOutcome,
    message.forwardDestination,
    message.forwardError,
    message.rfcMessageId,
    message.inReplyToHeader,
    message.referencesHeader,
    message.createdAt,
    message.updatedAt,
  ] as const;
  let total = 0;
  for (const value of strings) {
    if (value !== null) total += utf8ByteLength(value);
  }
  for (const contact of [...message.from, ...message.replyTo, ...message.to, ...message.cc]) {
    total += utf8ByteLength(contact.address);
    if (contact.displayName !== null) total += utf8ByteLength(contact.displayName);
  }
  return total;
}

type NormalizedAttachment = {
  readonly id: InboundAttachmentId;
  readonly position: number;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly key: AttachmentObjectKey;
  readonly contentId: string | null;
  readonly disposition: string | null;
  readonly isInline: number;
  readonly bytes: Uint8Array;
};

function normalizeAttachments(
  messageId: InboundMessageId,
  attachments: ReadonlyArray<Attachment>,
): ReadonlyArray<NormalizedAttachment> {
  const normalized: NormalizedAttachment[] = [];
  for (const [position, attachment] of attachments.entries()) {
    const bytes = attachmentBytes(attachment.content);
    const contentId =
      attachment.contentId === undefined ? null : normalizeContentId(attachment.contentId);
    const disposition = attachment.disposition;
    normalized.push({
      id: inboundAttachmentId(messageId, position),
      position,
      filename: sanitizeFilename(attachment.filename),
      mimeType: attachment.mimeType.length === 0 ? "application/octet-stream" : attachment.mimeType,
      size: bytes.byteLength,
      key: attachmentObjectKey(messageId, position),
      contentId,
      disposition,
      isInline: disposition === "inline" || attachment.related === true ? 1 : 0,
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

type ForwardColumns = {
  readonly outcome: "none" | "success" | "failure";
  readonly destination: string | null;
  readonly error: string | null;
};

function forwardColumns(outcome: ForwardOutcome): ForwardColumns {
  switch (outcome.kind) {
    case "none":
      return { outcome: "none", destination: null, error: null };
    case "success":
      return { outcome: "success", destination: outcome.destination, error: null };
    case "failure":
      return { outcome: "failure", destination: outcome.destination, error: outcome.error };
  }
}
