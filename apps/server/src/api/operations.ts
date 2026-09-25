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
  ApiProblem,
  ArchiveTransportProblem,
  MailContact,
  MailMessagePage,
  MailThreadDetail,
  MailThreadPage,
  OutboundJobStatusPage,
  ReplyPlan,
  SendingIdentity,
  buildOutboundReferences,
  headerBlock,
  joinRfcMessageIds,
  OutboundMessageHasNoSource,
  parseUtcInstant,
  SubmissionRequestId,
  type ListJobsQuery,
  type ListMessagesQuery,
  type ListThreadMessagesQuery,
  type Principal,
  type SubmitMessagePayload,
} from "@umail/api-contract";
import type * as Alchemy from "alchemy";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import type { ApiDeps } from "./app.ts";
import { randomId } from "../crypto.ts";
import { newApprovalCapability } from "../mail/notifications.ts";
import {
  projectJobStatus,
  projectMessageSummary,
  projectThreadMessage,
  projectThreadSummary,
} from "./projection.ts";
import { mailboxAllowed, mailboxScopeOf, requireRead, requireSend } from "./principal.ts";
import { deriveReplyRecipients, type ReplyMode } from "./reply-plan.ts";

const HTML_BODY_VALIDATION_PROBLEM = "The HTML body could not be processed safely." as const;

export type StoreHttpError =
  | HttpApiError.NotFound
  | HttpApiError.Forbidden
  | HttpApiError.Conflict
  | HttpApiError.BadRequest;

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
        return Effect.fail(new HttpApiError.NotFound());
      case "JobAuthorizationError":
        return Effect.fail(new HttpApiError.Forbidden());
      case "AccountConflictError":
      case "SubmissionConflictError":
        return Effect.fail(new HttpApiError.Conflict());
      case "MessageConflictError":
        return Effect.die(error);
    }
  });

export function listSendingIdentities(deps: ApiDeps, principal: Principal) {
  return Effect.gen(function* () {
    const identities = yield* deps.account
      .listSendingIdentities(mailboxScopeOf(principal))
      .pipe(storeCall);
    return identities.map((identity) => new SendingIdentity(identity));
  });
}

export function listThreads(
  deps: ApiDeps,
  principal: Principal,
  limit: number | undefined,
  cursor: string | undefined,
) {
  return Effect.gen(function* () {
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
}

// One page of a thread's message summaries, oldest first.
export function getThread(
  deps: ApiDeps,
  principal: Principal,
  threadId: string,
  query: ListThreadMessagesQuery = {},
) {
  return Effect.gen(function* () {
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
}

export function setThreadReadState(
  deps: ApiDeps,
  principal: Principal,
  threadId: string,
  isRead: boolean,
) {
  return Effect.gen(function* () {
    yield* requireRead(principal);
    const now = yield* currentIso;
    yield* deps.account
      .markThreadRead(threadId, isRead, mailboxScopeOf(principal), now)
      .pipe(storeCall);
    return yield* getThread(deps, principal, threadId);
  });
}

export function softDeleteVisibleThread(deps: ApiDeps, principal: Principal, threadId: string) {
  return Effect.gen(function* () {
    const now = yield* currentIso;
    yield* deps.account.softDeleteThread(threadId, mailboxScopeOf(principal), now).pipe(storeCall);
  });
}

export function listMessages(deps: ApiDeps, principal: Principal, query: ListMessagesQuery) {
  return Effect.gen(function* () {
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
}

export function getMessage(deps: ApiDeps, principal: Principal, id: string) {
  return Effect.gen(function* () {
    yield* requireRead(principal);
    const scope = mailboxScopeOf(principal);
    const summary = yield* deps.account.getMessageSummary(id, scope).pipe(storeCall);
    const body = yield* deps.account.getMessageBody(id, scope).pipe(storeCall);
    if (summary === null || body === null) {
      return yield* new HttpApiError.NotFound();
    }
    return projectThreadMessage(summary, body);
  });
}

export function readMessageSource(deps: ApiDeps, principal: Principal, messageId: string) {
  return Effect.gen(function* () {
    yield* requireRead(principal);
    const source = yield* deps.account
      .getMessageSource(messageId, mailboxScopeOf(principal))
      .pipe(storeCall);
    if (source === null) {
      return yield* new HttpApiError.NotFound();
    }
    if (source.direction === "outbound") {
      return yield* new OutboundMessageHasNoSource();
    }
    const bytes = yield* deps.archive.get(source.rawKey).pipe(
      Effect.mapError(
        () =>
          new ArchiveTransportProblem({
            message: "The message archive is temporarily unavailable.",
          }),
      ),
    );
    if (bytes === null) {
      return yield* new HttpApiError.NotFound();
    }
    return bytes;
  });
}

export function getMessageHeaders(deps: ApiDeps, principal: Principal, messageId: string) {
  return Effect.map(readMessageSource(deps, principal, messageId), headerBlock);
}

export function readAttachment(
  deps: ApiDeps,
  principal: Principal,
  messageId: string,
  attachmentId: string,
) {
  return Effect.gen(function* () {
    yield* requireRead(principal);
    const stored = yield* deps.account
      .getStoredAttachment(messageId, attachmentId, mailboxScopeOf(principal))
      .pipe(storeCall);
    if (stored === null) {
      return yield* new HttpApiError.NotFound();
    }
    const bytes = yield* deps.archive.get(stored.r2Key).pipe(
      Effect.mapError(
        () =>
          new ArchiveTransportProblem({
            message: "The attachment archive is temporarily unavailable.",
          }),
      ),
    );
    if (bytes === null) {
      return yield* new HttpApiError.NotFound();
    }
    return { stored, bytes };
  });
}

export function submitMessage(deps: ApiDeps, principal: Principal, payload: SubmitMessagePayload) {
  return Effect.gen(function* () {
    yield* requireSend(principal);
    const prepared = yield* prepareOutbound(deps, principal, payload);
    const now = yield* currentIso;
    const requestId = payload.requestId ?? SubmissionRequestId.make(yield* randomId);
    const submitted = yield* submitPrepared(deps, prepared, principal, requestId, now);
    return projectJobStatus(submitted.job);
  });
}

export function listJobs(deps: ApiDeps, principal: Principal, query: ListJobsQuery) {
  return Effect.gen(function* () {
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
}

export function getJob(deps: ApiDeps, principal: Principal, jobId: string) {
  return Effect.gen(function* () {
    const job = yield* deps.account.getOutboundJob(jobId, jobViewer(principal)).pipe(storeCall);
    if (job === null) {
      return yield* new HttpApiError.NotFound();
    }
    return projectJobStatus(job);
  });
}

export function getReplyPlan(
  deps: ApiDeps,
  principal: Principal,
  messageId: string,
  mode: ReplyMode,
) {
  return Effect.gen(function* () {
    const parent = yield* readReplyParent(deps, principal, messageId);
    const recipients = yield* replyRecipients(deps, parent, mode, parent.mailboxId);
    return new ReplyPlan({
      replyToMessageId: messageId,
      replyMode: mode,
      fromAddressId: parent.mailboxId,
      to: recipients.to,
      cc: recipients.cc,
      subject: parent.subject,
    });
  });
}

// Replying requires read access to the message being answered.
function readReplyParent(deps: ApiDeps, principal: Principal, messageId: string) {
  return Effect.gen(function* () {
    yield* requireRead(principal);
    const parent = yield* deps.account
      .getMessageSummary(messageId, mailboxScopeOf(principal))
      .pipe(storeCall);
    if (parent === null) {
      return yield* new HttpApiError.NotFound();
    }
    return parent;
  });
}

// Derives the reply's To/CC from the parent, as sent from `sendingAddressId`.
function replyRecipients(
  deps: ApiDeps,
  parent: MessageSummary,
  mode: ReplyMode,
  sendingAddressId: string,
) {
  return Effect.gen(function* () {
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
      return yield* new ApiProblem({
        message: "The message being replied to has no recipients.",
      });
    }
    const to: readonly [MailContact, ...Array<MailContact>] = [first, ...rest];
    return { to, cc: recipients.cc };
  });
}

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

function prepareOutbound(deps: ApiDeps, principal: Principal, payload: SubmitMessagePayload) {
  return Effect.gen(function* () {
    const text = payload.text === undefined ? null : payload.text;
    const suppliedHtml = payload.html === undefined ? null : payload.html;
    const identity = yield* deps.account
      .resolveSendingIdentity(payload.fromAddressId)
      .pipe(storeCall);
    if (identity === null) {
      return yield* new ApiProblem({ message: "The from address is unknown or inactive." });
    }
    if (!mailboxAllowed(principal, identity.id)) {
      return yield* new HttpApiError.Forbidden();
    }
    const recipients = yield* resolveSubmitRecipients(deps, principal, payload);
    if (recipients.to.length + recipients.cc.length > MAX_OUTBOUND_RECIPIENTS) {
      return yield* new ApiProblem({
        message: "A message may have at most 50 To and CC recipients.",
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
}

function resolveSubmitRecipients(
  deps: ApiDeps,
  principal: Principal,
  payload: SubmitMessagePayload,
) {
  return Effect.gen(function* () {
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
    const recipients = yield* replyRecipients(
      deps,
      parent,
      payload.replyMode,
      payload.fromAddressId,
    );
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
}

function submitPrepared(
  deps: ApiDeps,
  prepared: PreparedOutbound,
  principal: Principal,
  requestId: SubmissionRequestId,
  nowIso: string,
): Effect.Effect<SubmitOutboundResult, StoreHttpError, Crypto.Crypto | Alchemy.RuntimeContext> {
  return Effect.gen(function* () {
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
}

// Outbound mail has no attachments, so no `cid:` image resolves and the message id is never used.
function sanitizeOutboundHtml(deps: ApiDeps, suppliedHtml: string | null) {
  if (suppliedHtml === null) {
    return Effect.succeed(null);
  }
  return deps.htmlPolicy
    .sanitizeForStorage(suppliedHtml, { messageId: "outbound", attachments: [] })
    .pipe(Effect.mapError(() => new ApiProblem({ message: HTML_BODY_VALIDATION_PROBLEM })));
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
function decodeCursor(
  cursor: string | undefined,
): Effect.Effect<PageCursor | undefined, HttpApiError.BadRequest> {
  if (cursor === undefined) {
    return Effect.succeed(undefined);
  }
  const decoded = Encoding.decodeBase64UrlString(cursor);
  if (Result.isFailure(decoded)) {
    return new HttpApiError.BadRequest();
  }
  const text = decoded.success;
  const separator = text.indexOf("\n");
  if (separator <= 0 || separator !== text.lastIndexOf("\n")) {
    return new HttpApiError.BadRequest();
  }
  const at = text.slice(0, separator);
  const id = text.slice(separator + 1);
  if (id.length === 0 || parseUtcInstant(at) !== at) {
    return new HttpApiError.BadRequest();
  }
  return Effect.succeed({ at, id });
}

function encodeCursor(cursor: PageCursor | null): string | null {
  return cursor === null ? null : Encoding.encodeBase64Url(`${cursor.at}\n${cursor.id}`);
}
