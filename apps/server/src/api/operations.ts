import {
  MAX_OUTBOUND_RECIPIENTS,
  type AccountMailContact,
  type JobViewer,
  type MessageSummary,
  type OutboundRequester,
  type PageCursor,
  type SubmitOutboundInput,
  type SubmitOutboundResult,
} from "../account/domain.ts";
import { isExpectedStoreFailure, type AccountStoreError } from "../account/errors.ts";
import {
  Address,
  AddressForwarding,
  Conflict,
  InvalidRequest,
  MailContact,
  MailMessagePage,
  MailThreadDetail,
  MailThreadPage,
  OutboundJobStatusPage,
  SendingIdentity,
  buildOutboundReferences,
  headerBlock,
  joinRfcMessageIds,
  NotFound,
  NotPermitted,
  parseUtcInstant,
  Unavailable,
  type SubmissionRequestId,
  type ListJobsQuery,
  type ListMessagesQuery,
  type ListThreadMessagesQuery,
  type NotFoundCode,
  type PatchAddressPayload,
  type Principal,
  type SubmitMessagePayload,
} from "@umail/api-contract";
import type * as Alchemy from "alchemy";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

import type { ApiDeps } from "./app.ts";
import { newApprovalCapability } from "../mail/notifications.ts";
import {
  projectJobStatus,
  projectMessageSummary,
  projectThreadMessage,
  projectThreadSummary,
} from "./projection.ts";
import { mailboxAllowed, mailboxScopeOf, requireRead, requireSend } from "./principal.ts";
import { deriveReplyRecipients, type ReplyMode } from "./reply-plan.ts";

type StoreHttpError = NotFound | NotPermitted | Conflict;

// Expected store errors cross the DO RPC boundary as plain `{ _tag, ... }` objects, so they are
// classified by tag only. Anything else (a DO defect or transport failure arrives as alchemy's
// `RpcCallError`) is a defect: alchemy logs it and answers 500.
export const storeCall = <A, R>(
  effect: Effect.Effect<A, AccountStoreError, R>,
): Effect.Effect<A, StoreHttpError, R> =>
  Effect.catch(effect, (error: unknown): Effect.Effect<never, StoreHttpError> => {
    if (!isExpectedStoreFailure(error)) {
      return Effect.die(error);
    }
    switch (error._tag) {
      case "ThreadNotFoundError":
        return Effect.fail(notFound("thread_not_found", `Thread ${error.threadId}`));
      case "JobAuthorizationError":
        return Effect.fail(
          new NotPermitted({
            code: error.reason,
            message: "This client may not send this message.",
          }),
        );
      case "AccountConflictError":
        return Effect.fail(
          new Conflict({ code: "address_exists", message: "That address already exists." }),
        );
      case "SubmissionConflictError":
        return Effect.fail(
          new Conflict({
            code: "request_id_reused",
            message: `requestId ${error.requestId} was already used for different content.`,
          }),
        );
      case "MessageConflictError":
        return Effect.die(error);
    }
  });

// Mailboxes are operator-only: REST reaches these only with an operator token, the console only
// with the operator's session.
export const createAddress = Effect.fn("createAddress")(function* (
  deps: ApiDeps,
  input: { readonly localPart: string; readonly displayName?: string },
) {
  const now = yield* currentIso;
  const address = yield* deps.account
    .createAddress(input.localPart, deps.mailDomain, input.displayName, now)
    .pipe(storeCall);
  if (address === null) {
    return yield* new InvalidRequest({
      code: "address_invalid",
      message: `"${input.localPart}" is not a valid mailbox name.`,
    });
  }
  return new Address(address);
});

export const listAddresses = Effect.fn("listAddresses")(function* (deps: ApiDeps) {
  const addresses = yield* deps.account.listAddresses().pipe(storeCall);
  return addresses.map((address) => new Address(address));
});

export const getAddress = Effect.fn("getAddress")(function* (deps: ApiDeps, id: string) {
  const address = yield* deps.account.getAddress(id).pipe(storeCall);
  if (address === null) {
    return yield* notFound("mailbox_not_found", `Mailbox ${id}`);
  }
  return new Address(address);
});

export const patchAddress = Effect.fn("patchAddress")(function* (
  deps: ApiDeps,
  id: string,
  patch: PatchAddressPayload,
) {
  const now = yield* currentIso;
  const address = yield* deps.account.patchAddress(id, patch, now).pipe(storeCall);
  if (address === null) {
    return yield* notFound("mailbox_not_found", `Mailbox ${id}`);
  }
  return new Address(address);
});

// Cloudflare forwards only to a verified destination, so the destination is registered first.
export const setAddressForwarding = Effect.fn("setAddressForwarding")(function* (
  deps: ApiDeps,
  id: string,
  email: string,
) {
  const address = yield* getAddress(deps, id);
  const destination = yield* deps.destinations
    .ensure(email)
    .pipe(
      Effect.mapError(
        (error) => new InvalidRequest({ code: "forwarding_rejected", message: error.message }),
      ),
    );
  const now = yield* currentIso;
  const updated = yield* deps.account
    .setAddressForwarding(address.id, destination.email, now)
    .pipe(storeCall);
  if (updated === null) {
    return yield* notFound("mailbox_not_found", `Mailbox ${id}`);
  }
  return new AddressForwarding({ address: new Address(updated), verified: destination.verified });
});

export const removeAddressForwarding = Effect.fn("removeAddressForwarding")(function* (
  deps: ApiDeps,
  id: string,
) {
  const now = yield* currentIso;
  const address = yield* deps.account.setAddressForwarding(id, null, now).pipe(storeCall);
  if (address === null) {
    return yield* notFound("mailbox_not_found", `Mailbox ${id}`);
  }
  return new Address(address);
});

export const listSendingIdentities = Effect.fn("listSendingIdentities")(function* (
  deps: ApiDeps,
  principal: Principal,
) {
  const identities = yield* deps.account
    .listSendingIdentities(mailboxScopeOf(principal))
    .pipe(storeCall);
  return identities.map((identity) => new SendingIdentity(identity));
});

export const listThreads = Effect.fn("listThreads")(function* (
  deps: ApiDeps,
  principal: Principal,
  limit: number | undefined,
  cursor: string | undefined,
) {
  yield* requireRead(principal);
  const page = yield* deps.account
    .listThreadSummaries({
      mailboxScope: mailboxScopeOf(principal),
      limit,
      cursor: yield* decodeCursor(cursor),
    })
    .pipe(storeCall);
  return new MailThreadPage({
    items: page.items.map(projectThreadSummary),
    nextCursor: encodeCursor(page.nextCursor),
  });
});

// One page of a thread's message summaries, oldest first.
export const getThread = Effect.fn("getThread")(function* (
  deps: ApiDeps,
  principal: Principal,
  threadId: string,
  query: ListThreadMessagesQuery = {},
) {
  yield* requireRead(principal);
  const page = yield* deps.account
    .listThreadMessageSummaries(threadId, {
      mailboxScope: mailboxScopeOf(principal),
      limit: query.limit,
      cursor: yield* decodeCursor(query.cursor),
    })
    .pipe(storeCall);
  return new MailThreadDetail({
    threadId: page.threadId,
    messages: page.items.map(projectMessageSummary),
    nextCursor: encodeCursor(page.nextCursor),
  });
});

export const setThreadReadState = Effect.fn("setThreadReadState")(function* (
  deps: ApiDeps,
  principal: Principal,
  threadId: string,
  isRead: boolean,
) {
  yield* requireRead(principal);
  const now = yield* currentIso;
  yield* deps.account
    .markThreadRead(threadId, isRead, mailboxScopeOf(principal), now)
    .pipe(storeCall);
  return yield* getThread(deps, principal, threadId);
});

export const softDeleteVisibleThread = Effect.fn("softDeleteVisibleThread")(function* (
  deps: ApiDeps,
  principal: Principal,
  threadId: string,
) {
  const now = yield* currentIso;
  yield* deps.account.softDeleteThread(threadId, mailboxScopeOf(principal), now).pipe(storeCall);
});

export const listMessages = Effect.fn("listMessages")(function* (
  deps: ApiDeps,
  principal: Principal,
  query: ListMessagesQuery,
) {
  yield* requireRead(principal);
  if (query.addressId !== undefined && !mailboxAllowed(principal, query.addressId)) {
    return new MailMessagePage({ items: [], nextCursor: null });
  }
  const page = yield* deps.account
    .listMessageSummaries({
      mailboxScope: mailboxScopeOf(principal),
      direction: query.direction,
      addressId: query.addressId,
      since: query.since,
      unread: query.unread,
      limit: query.limit,
      cursor: yield* decodeCursor(query.cursor),
    })
    .pipe(storeCall);
  return new MailMessagePage({
    items: page.items.map(projectMessageSummary),
    nextCursor: encodeCursor(page.nextCursor),
  });
});

export const getMessage = Effect.fn("getMessage")(function* (
  deps: ApiDeps,
  principal: Principal,
  id: string,
) {
  yield* requireRead(principal);
  const scope = mailboxScopeOf(principal);
  const summary = yield* deps.account.getMessageSummary(id, scope).pipe(storeCall);
  const body = yield* deps.account.getMessageBody(id, scope).pipe(storeCall);
  if (summary === null || body === null) {
    return yield* notFound("message_not_found", `Message ${id}`);
  }
  return projectThreadMessage(summary, body);
});

export const readMessageSource = Effect.fn("readMessageSource")(function* (
  deps: ApiDeps,
  principal: Principal,
  messageId: string,
) {
  yield* requireRead(principal);
  const source = yield* deps.account
    .getMessageSource(messageId, mailboxScopeOf(principal))
    .pipe(storeCall);
  if (source === null) {
    return yield* notFound("message_not_found", `Message ${messageId}`);
  }
  if (source.direction === "outbound") {
    return yield* new Conflict({
      code: "no_archived_source",
      message: `Message ${messageId} was sent by AgentMail and has no archived source; only inbound messages are archived.`,
    });
  }
  const bytes = yield* deps.archive.get(source.rawKey).pipe(Effect.mapError(archiveUnavailable));
  if (bytes === null) {
    return yield* notFound("source_not_found", `The archived source of message ${messageId}`);
  }
  return bytes;
});

export function getMessageHeaders(deps: ApiDeps, principal: Principal, messageId: string) {
  return Effect.map(readMessageSource(deps, principal, messageId), headerBlock);
}

export const readAttachment = Effect.fn("readAttachment")(function* (
  deps: ApiDeps,
  principal: Principal,
  messageId: string,
  attachmentId: string,
) {
  yield* requireRead(principal);
  const stored = yield* deps.account
    .getStoredAttachment(messageId, attachmentId, mailboxScopeOf(principal))
    .pipe(storeCall);
  if (stored === null) {
    return yield* notFound("attachment_not_found", `Attachment ${attachmentId}`);
  }
  const bytes = yield* deps.archive.get(stored.r2Key).pipe(Effect.mapError(archiveUnavailable));
  if (bytes === null) {
    return yield* notFound("attachment_not_found", `Attachment ${attachmentId}`);
  }
  return { stored, bytes };
});

export const submitMessage = Effect.fn("submitMessage")(function* (
  deps: ApiDeps,
  principal: Principal,
  payload: SubmitMessagePayload,
) {
  yield* requireSend(principal);
  const prepared = yield* prepareOutbound(deps, principal, payload);
  const now = yield* currentIso;
  const submitted = yield* submitPrepared(deps, prepared, principal, payload.requestId, now);
  return projectJobStatus(submitted.job);
});

export const listJobs = Effect.fn("listJobs")(function* (
  deps: ApiDeps,
  principal: Principal,
  query: ListJobsQuery,
) {
  const page = yield* deps.account
    .listOutboundJobs({
      viewer: jobViewer(principal),
      limit: query.limit,
      cursor: yield* decodeCursor(query.cursor),
    })
    .pipe(storeCall);
  return new OutboundJobStatusPage({
    items: page.items.map(projectJobStatus),
    nextCursor: encodeCursor(page.nextCursor),
  });
});

export const getJob = Effect.fn("getJob")(function* (
  deps: ApiDeps,
  principal: Principal,
  jobId: string,
) {
  const job = yield* deps.account.getOutboundJob(jobId, jobViewer(principal)).pipe(storeCall);
  if (job === null) {
    return yield* notFound("job_not_found", `Job ${jobId}`);
  }
  return projectJobStatus(job);
});

// Replying requires read access to the message being answered.
const readReplyParent = Effect.fn("readReplyParent")(function* (
  deps: ApiDeps,
  principal: Principal,
  messageId: string,
) {
  yield* requireRead(principal);
  const parent = yield* deps.account
    .getMessageSummary(messageId, mailboxScopeOf(principal))
    .pipe(storeCall);
  if (parent === null) {
    return yield* notFound("message_not_found", `Message ${messageId}`);
  }
  return parent;
});

// Derives the reply's To/CC from the parent, as sent from `sendingAddressId`.
const replyRecipients = Effect.fn("replyRecipients")(function* (
  deps: ApiDeps,
  parent: MessageSummary,
  mode: ReplyMode,
  sendingAddressId: string,
) {
  const addresses = yield* deps.account.listAddresses().pipe(storeCall);
  const registered = new Set(addresses.map((address) => address.address));
  const sending = yield* deps.account.getAddress(sendingAddressId).pipe(storeCall);
  const recipients = deriveReplyRecipients(
    parent.direction,
    mode,
    {
      from: parent.from.map(toMailContact),
      replyTo: parent.replyTo.map(toMailContact),
      to: parent.to.map(toMailContact),
      cc: parent.cc.map(toMailContact),
    },
    registered,
    deps.mailDomain,
    sending?.address,
  );
  const [first, ...rest] = recipients.to;
  if (first === undefined) {
    return yield* new InvalidRequest({
      code: "no_external_recipients",
      message: "The message being replied to has no recipients.",
    });
  }
  const to: readonly [MailContact, ...Array<MailContact>] = [first, ...rest];
  return { to, cc: recipients.cc };
});

// The recipients a reply would get, for the console to show before sending: the same derivation
// `submitMessage` runs, from the parent's own mailbox.
export const previewReplyRecipients = Effect.fn("previewReplyRecipients")(function* (
  deps: ApiDeps,
  principal: Principal,
  messageId: string,
  mode: ReplyMode,
) {
  const parent = yield* readReplyParent(deps, principal, messageId);
  const recipients = yield* replyRecipients(deps, parent, mode, parent.mailboxId);
  return { parent, ...recipients };
});

type PreparedOutbound = {
  readonly mailboxId: string;
  readonly subject: string;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly hasRemoteImages: boolean;
  readonly to: SubmitOutboundInput["to"];
  readonly cc: SubmitOutboundInput["cc"];
  readonly inReplyToHeader: string | null;
  readonly referencesHeader: string | null;
};

const prepareOutbound = Effect.fn("prepareOutbound")(function* (
  deps: ApiDeps,
  principal: Principal,
  payload: SubmitMessagePayload,
) {
  const text = payload.text === undefined ? null : payload.text;
  const suppliedHtml = payload.html === undefined ? null : payload.html;
  const identity = yield* deps.account
    .resolveSendingIdentity(payload.fromAddressId)
    .pipe(storeCall);
  if (identity === null) {
    return yield* new InvalidRequest({
      code: "from_address_unknown",
      message: `Sending identity ${payload.fromAddressId} is unknown or inactive.`,
    });
  }
  if (!mailboxAllowed(principal, identity.id)) {
    return yield* new NotPermitted({
      code: "mailbox_forbidden",
      message: `This client may not send from mailbox ${identity.id}.`,
    });
  }
  const recipients = yield* resolveSubmitRecipients(deps, principal, payload);
  if (recipients.to.length + recipients.cc.length > MAX_OUTBOUND_RECIPIENTS) {
    return yield* new InvalidRequest({
      code: "too_many_recipients",
      message: `A message may have at most ${MAX_OUTBOUND_RECIPIENTS} To and CC recipients.`,
    });
  }
  const storedHtml = yield* sanitizeOutboundHtml(deps, suppliedHtml);
  return {
    mailboxId: identity.id,
    subject: payload.subject,
    textBody: text,
    htmlBody: storedHtml?.body ?? null,
    hasRemoteImages: storedHtml?.hasRemoteImages ?? false,
    to: toAccountMailContacts(recipients.to),
    cc: recipients.cc.map(toAccountMailContact),
    inReplyToHeader: recipients.inReplyToHeader,
    referencesHeader: recipients.referencesHeader,
  };
});

const resolveSubmitRecipients = Effect.fn("resolveSubmitRecipients")(function* (
  deps: ApiDeps,
  principal: Principal,
  payload: SubmitMessagePayload,
) {
  if (payload.intent === "compose") {
    const cc = payload.cc === undefined ? [] : payload.cc;
    return {
      to: payload.to,
      cc,
      inReplyToHeader: null,
      referencesHeader: null,
    };
  }
  const parent = yield* readReplyParent(deps, principal, payload.replyToMessageId);
  const recipients = yield* replyRecipients(deps, parent, payload.replyMode, payload.fromAddressId);
  const references =
    parent.rfcMessageId === null
      ? []
      : buildOutboundReferences(parent.rfcMessageId, parent.references);
  return {
    to: recipients.to,
    cc: recipients.cc,
    inReplyToHeader: parent.rfcMessageId,
    referencesHeader: references.length === 0 ? null : joinRfcMessageIds(references),
  };
});

const submitPrepared = Effect.fn("submitPrepared")(function* (
  deps: ApiDeps,
  prepared: PreparedOutbound,
  principal: Principal,
  requestId: SubmissionRequestId,
  nowIso: string,
): Effect.fn.Return<SubmitOutboundResult, StoreHttpError, Crypto.Crypto | Alchemy.RuntimeContext> {
  const approval = yield* newApprovalCapability(yield* deps.notificationKey, nowIso);
  return yield* deps.account
    .submitOutbound({
      requestId,
      requester: outboundRequester(principal),
      policy: principal.policy,
      mailboxId: prepared.mailboxId,
      subject: prepared.subject,
      textBody: prepared.textBody,
      htmlBody: prepared.htmlBody,
      hasRemoteImages: prepared.hasRemoteImages,
      to: prepared.to,
      cc: prepared.cc,
      inReplyToHeader: prepared.inReplyToHeader,
      referencesHeader: prepared.referencesHeader,
      nowIso,
      approval,
    })
    .pipe(storeCall);
});

// Outbound mail has no attachments, so no `cid:` image resolves and the message id is never used.
function sanitizeOutboundHtml(deps: ApiDeps, suppliedHtml: string | null) {
  if (suppliedHtml === null) {
    return Effect.succeed(null);
  }
  return deps.htmlPolicy
    .sanitizeForStorage(suppliedHtml, { messageId: "outbound", attachments: [] })
    .pipe(
      Effect.mapError(
        () =>
          new InvalidRequest({
            code: "html_unsafe",
            message: "The HTML body could not be processed safely.",
          }),
      ),
    );
}

function outboundRequester(principal: Principal): OutboundRequester {
  return {
    kind: principal.authority,
    clientId: principal.identity.clientId,
    label: principal.identity.clientLabel,
  };
}

function jobViewer(principal: Principal): JobViewer {
  if (principal.authority === "operator") {
    return { kind: "operator" };
  }
  return { kind: "mcp", clientId: principal.identity.clientId };
}

export const currentIso = Effect.map(DateTime.now, DateTime.formatIso);

function toMailContact(contact: { address: MailContact["address"]; displayName: string | null }) {
  return new MailContact({ address: contact.address, displayName: contact.displayName });
}

function toAccountMailContact(contact: MailContact): AccountMailContact {
  return {
    address: contact.address,
    displayName: contact.displayName,
  };
}

function toAccountMailContacts(
  contacts: readonly [MailContact, ...Array<MailContact>],
): SubmitOutboundInput["to"] {
  const [first, ...rest] = contacts;
  return [toAccountMailContact(first), ...rest.map(toAccountMailContact)];
}

// Wire form: base64url of `<timestamp>\n<id>`. A cursor whose timestamp is not a canonical instant
// is rejected with 400.
const decodeCursor = Effect.fn("decodeCursor")(function* (cursor: string | undefined) {
  if (cursor === undefined) {
    return undefined;
  }
  const decoded = Encoding.decodeBase64UrlString(cursor);
  if (Result.isFailure(decoded)) {
    return yield* invalidCursor;
  }
  const text = decoded.success;
  const separator = text.indexOf("\n");
  if (separator <= 0 || separator !== text.lastIndexOf("\n")) {
    return yield* invalidCursor;
  }
  const at = text.slice(0, separator);
  const id = text.slice(separator + 1);
  if (id.length === 0 || parseUtcInstant(at) !== at) {
    return yield* invalidCursor;
  }
  return { at, id } satisfies PageCursor;
});

const invalidCursor = new InvalidRequest({
  code: "invalid_cursor",
  message: "The cursor is not valid.",
});

// Unknown ids and ids outside the caller's access get the same answer.
function notFound(code: NotFoundCode, subject: string) {
  return new NotFound({
    code,
    message: `${subject} was not found, or it is outside this client's access.`,
  });
}

function archiveUnavailable() {
  return new Unavailable({
    code: "archive_unavailable",
    message: "The message archive is temporarily unavailable. Try again.",
  });
}

function encodeCursor(cursor: PageCursor | null): string | null {
  return cursor === null ? null : Encoding.encodeBase64Url(`${cursor.at}\n${cursor.id}`);
}
