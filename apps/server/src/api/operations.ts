import {
  JobViewer,
  OutboundRequester,
  SubmitOutboundInput,
  type AccountMailContact,
  type ApprovalCapabilityWrite,
  type JobListCursor,
  type ListMessageSummariesQuery,
  type ListOutboundJobsQuery,
  type ListThreadMessageSummariesQuery,
  type ListThreadSummariesQuery,
  type MessageListCursor,
  type SubmitOutboundResult,
  type ThreadListCursor,
} from "../account/domain.ts";
import { type AccountStoreError } from "../account/errors.ts";
import {
  ApiProblem,
  ArchiveTransportProblem,
  ComposeMessagePayload,
  MailContact,
  MailMessagePage,
  MailThreadDetail,
  MailThreadMessagePage,
  MailThreadPage,
  OutboundJobStatusPage,
  ReplyPlan,
  approvalNotificationIdempotencyKey,
  buildOutboundReferences,
  hashApprovalToken,
  headerBlock,
  joinRfcMessageIds,
  normalizeRfcMessageId,
  OutboundMessageHasNoSource,
  parseMailboxAddress,
  SubmissionRequestId,
  ThreadHandle,
  type ListJobsQuery,
  type ListMessagesQuery,
  type ListThreadMessagesQuery,
  type MailDomain,
  type McpPrincipal,
  type Principal,
  type SendMessagePayload,
  SubmitMessagePayload,
  UpdateMcpClientPolicyPayload,
} from "@umail/api-contract";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import type { ApiDeps } from "./app.ts";
import { APPROVAL_TTL_HOURS } from "./approvals.ts";
import { encryptNotificationPayload, notificationIdentity } from "../mail/notifications.ts";
import {
  MAX_OUTBOUND_RECIPIENTS,
  projectJobStatus,
  projectMcpClient,
  projectMessageSummary,
  projectSendingIdentities,
  projectThreadMessage,
  projectThreadSummary,
} from "./projection.ts";
import { mailboxAllowed, mailboxScopeOf, requireRead, requireSend } from "./principal.ts";
import { deriveReplyRecipients } from "./reply-plan.ts";

const HTML_BODY_VALIDATION_PROBLEM = "The HTML body could not be processed safely." as const;

type StoreMappedError =
  | HttpApiError.NotFound
  | HttpApiError.BadRequest
  | HttpApiError.Forbidden
  | HttpApiError.Conflict
  | ApiProblem;

type StoreReadError = HttpApiError.NotFound | HttpApiError.BadRequest | HttpApiError.Forbidden;

export function reloadPrincipal(
  deps: ApiDeps,
  principal: Principal,
): Effect.Effect<Principal, HttpApiError.Forbidden> {
  if (principal.authority === "operator") {
    return Effect.succeed(principal);
  }
  return deps.account.getMcpOAuthPolicy(principal.identity.clientId).pipe(
    Effect.mapError(() => new HttpApiError.Forbidden()),
    Effect.flatMap((stored) => {
      if (stored === null || stored.state !== "active") {
        return new HttpApiError.Forbidden();
      }
      return Effect.succeed({
        authority: "mcp",
        identity: {
          kind: "oauth" as const,
          userId: principal.identity.userId,
          clientId: principal.identity.clientId,
          clientLabel: stored.label,
        },
        policy: stored.policy,
      } satisfies McpPrincipal);
    }),
  );
}

export function listSendingIdentities(deps: ApiDeps, principal: Principal) {
  return Effect.gen(function* () {
    const current = yield* reloadPrincipal(deps, principal).pipe(
      Effect.catchTag("Forbidden", () => Effect.succeed(null)),
    );
    if (current === null) {
      return [];
    }
    const identities = yield* deps.account
      .listSendingIdentities(deps.mailDomain, mailboxScopeOf(current))
      .pipe(Effect.mapError(mapReadError));
    return projectSendingIdentities(identities);
  });
}

export function listThreads(
  deps: ApiDeps,
  principal: Principal,
  limit: number | undefined,
  cursor: string | undefined,
) {
  return Effect.gen(function* () {
    const current = yield* reloadPrincipal(deps, principal);
    yield* requireRead(current);
    const decodedCursor = yield* decodeThreadCursor(cursor);
    const query = threadListQuery(current, deps.mailDomain, limit, decodedCursor);
    const page = yield* deps.account.listThreadSummaries(query).pipe(Effect.mapError(mapReadError));
    const items = [];
    for (const summary of page.items) {
      const projected = projectThreadSummary(summary);
      if (projected !== null) {
        items.push(projected);
      }
    }
    const nextCursor =
      page.nextCursor === null
        ? null
        : encodeThreadCursor(page.nextCursor.lastActivityAt, page.nextCursor.threadHandle);
    return new MailThreadPage({ items, nextCursor });
  });
}

export function getThread(deps: ApiDeps, principal: Principal, threadId: string) {
  return Effect.gen(function* () {
    const page = yield* listThreadMessages(deps, principal, threadId, {});
    return new MailThreadDetail({
      threadId: page.threadHandle,
      messages: page.items,
      nextCursor: page.nextCursor,
    });
  });
}

export function listThreadMessages(
  deps: ApiDeps,
  principal: Principal,
  threadId: string,
  query: ListThreadMessagesQuery,
) {
  return Effect.gen(function* () {
    const current = yield* reloadPrincipal(deps, principal);
    yield* requireRead(current);
    const decodedCursor = yield* decodeMessageCursor(query.cursor);
    const page = yield* deps.account
      .listThreadMessageSummaries(
        threadId,
        threadMessageListQuery(current, query.limit, decodedCursor),
      )
      .pipe(Effect.mapError(mapReadError));
    const items = [];
    for (const summary of page.items) {
      const projected = projectMessageSummary(summary);
      if (projected !== null) {
        items.push(projected);
      }
    }
    return new MailThreadMessagePage({
      threadHandle: Schema.decodeSync(ThreadHandle)(page.threadHandle),
      items,
      nextCursor: encodeOptionalMessageCursor(page.nextCursor),
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
    const current = yield* reloadPrincipal(deps, principal);
    yield* requireRead(current);
    const now = yield* currentIso(deps);
    yield* deps.account
      .markThreadRead(threadId, isRead, mailboxScopeOf(current), now)
      .pipe(Effect.mapError(mapReadError));
    return yield* getThread(deps, current, threadId);
  });
}

export function softDeleteVisibleThread(deps: ApiDeps, principal: Principal, threadId: string) {
  return Effect.gen(function* () {
    const current = yield* reloadPrincipal(deps, principal);
    const now = yield* currentIso(deps);
    yield* deps.account
      .softDeleteThread(threadId, mailboxScopeOf(current), now)
      .pipe(Effect.mapError(mapReadError));
  });
}

export function listMessages(deps: ApiDeps, principal: Principal, query: ListMessagesQuery) {
  return Effect.gen(function* () {
    const current = yield* reloadPrincipal(deps, principal);
    yield* requireRead(current);
    if (query.addressId !== undefined && !mailboxAllowed(current, query.addressId)) {
      return new MailMessagePage({ items: [], nextCursor: null });
    }
    const decodedCursor = yield* decodeMessageCursor(query.cursor);
    const page = yield* deps.account
      .listMessageSummaries(messageListQuery(current, query, decodedCursor))
      .pipe(Effect.mapError(mapReadError));
    const items = [];
    for (const summary of page.items) {
      const projected = projectMessageSummary(summary);
      if (projected !== null) {
        items.push(projected);
      }
    }
    return new MailMessagePage({
      items,
      nextCursor: encodeOptionalMessageCursor(page.nextCursor),
    });
  });
}

export function getMessage(deps: ApiDeps, principal: Principal, id: string) {
  return Effect.gen(function* () {
    const current = yield* reloadPrincipal(deps, principal);
    yield* requireRead(current);
    const scope = mailboxScopeOf(current);
    const summary = yield* deps.account
      .getMessageSummary(id, scope)
      .pipe(Effect.mapError(mapReadError));
    const body = yield* deps.account.getMessageBody(id, scope).pipe(Effect.mapError(mapReadError));
    if (summary === null || body === null) {
      return yield* new HttpApiError.NotFound();
    }
    const message = projectThreadMessage(summary, body);
    if (message === null) {
      return yield* new HttpApiError.NotFound();
    }
    return message;
  });
}

export function readMessageSource(deps: ApiDeps, principal: Principal, messageId: string) {
  return Effect.gen(function* () {
    const current = yield* reloadPrincipal(deps, principal);
    yield* requireRead(current);
    const source = yield* deps.account
      .getMessageSource(messageId, mailboxScopeOf(current))
      .pipe(Effect.mapError(mapReadError));
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
    const current = yield* reloadPrincipal(deps, principal);
    yield* requireRead(current);
    const stored = yield* deps.account
      .getStoredAttachment(messageId, attachmentId, mailboxScopeOf(current))
      .pipe(Effect.mapError(mapReadError));
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
    const current = yield* reloadPrincipal(deps, principal);
    yield* requireSend(current);
    const prepared = yield* prepareOutbound(deps, current, payload);
    const requester = outboundRequester(current);
    const now = yield* currentIso(deps);
    const submitted = yield* submitPrepared(deps, prepared, requester, payload.requestId, now);
    return projectJobStatus(submitted.job);
  });
}

export function sendMessage(deps: ApiDeps, principal: Principal, payload: SendMessagePayload) {
  const requestId = Schema.decodeSync(SubmissionRequestId)(crypto.randomUUID());
  return submitMessage(deps, principal, toSubmitPayload(payload, requestId));
}

export function listJobs(deps: ApiDeps, principal: Principal, query: ListJobsQuery) {
  return Effect.gen(function* () {
    const current = yield* reloadPrincipal(deps, principal);
    const decodedCursor = yield* decodeJobCursor(query.cursor);
    const page = yield* deps.account
      .listOutboundJobs(jobListQuery(current, query.limit, decodedCursor))
      .pipe(Effect.mapError(mapReadError));
    const nextCursor =
      page.nextCursor === null
        ? null
        : encodeJobCursor(page.nextCursor.createdAt, page.nextCursor.jobId);
    return new OutboundJobStatusPage({
      items: page.items.map(projectJobStatus),
      nextCursor,
    });
  });
}

export function getJob(deps: ApiDeps, principal: Principal, jobId: string) {
  return Effect.gen(function* () {
    const current = yield* reloadPrincipal(deps, principal);
    const job = yield* deps.account
      .getOutboundJob(jobId, jobViewer(current))
      .pipe(Effect.mapError(mapReadError));
    if (job === null) {
      return yield* new HttpApiError.NotFound();
    }
    return projectJobStatus(job);
  });
}

export function computeReplyPlan(
  deps: ApiDeps,
  principal: Principal,
  messageId: string,
  mode: "reply" | "reply-all",
  sendingAddressId?: string,
) {
  return Effect.gen(function* () {
    const current = yield* reloadPrincipal(deps, principal);
    yield* requireRead(current);
    const summary = yield* deps.account
      .getMessageSummary(messageId, mailboxScopeOf(current))
      .pipe(Effect.mapError(mapReadError));
    if (summary === null) {
      return yield* new HttpApiError.NotFound();
    }
    const addresses = yield* deps.account.listAddresses().pipe(Effect.mapError(mapReadError));
    const registered = new Set(
      addresses.flatMap((address) => {
        const parsed = parseMailboxAddress(address.address);
        return parsed.kind === "ok" && parsed.domain === deps.mailDomain ? [parsed.address] : [];
      }),
    );
    const sendingId = sendingAddressId ?? summary.mailboxId;
    const sending = yield* deps.account.getAddress(sendingId).pipe(Effect.mapError(mapReadError));
    const sendingMailbox = sending === null ? undefined : parseMailboxAddress(sending.address);
    const recipients = deriveReplyRecipients(
      summary.direction,
      mode,
      {
        from: summary.from.map(toMailContact),
        replyTo: summary.replyTo.map(toMailContact),
        to: summary.to.map(toMailContact),
        cc: summary.cc.map(toMailContact),
      },
      registered,
      deps.mailDomain,
      sendingMailbox?.kind === "ok" ? sendingMailbox.address : undefined,
    );
    if (recipients.to.length === 0) {
      return yield* new ApiProblem({
        message: "The message being replied to has no recipients.",
      });
    }
    return new ReplyPlan({
      replyToMessageId: messageId,
      replyMode: mode,
      fromAddressId: summary.mailboxId,
      to: recipients.to,
      cc: recipients.cc,
      subject: summary.subject,
    });
  });
}

export function getReplyPlan(
  deps: ApiDeps,
  principal: Principal,
  messageId: string,
  mode: "reply" | "reply-all",
) {
  return computeReplyPlan(deps, principal, messageId, mode);
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
      .resolveSendingIdentity(payload.fromAddressId, deps.mailDomain)
      .pipe(Effect.mapError(mapReadError));
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
    const plan = yield* computeReplyPlan(
      deps,
      principal,
      payload.replyToMessageId,
      payload.replyMode,
      payload.fromAddressId,
    );
    const parent = yield* deps.account
      .getMessageSummary(payload.replyToMessageId, mailboxScopeOf(principal))
      .pipe(Effect.mapError(mapReadError));
    if (parent === null) {
      return yield* new HttpApiError.NotFound();
    }
    const parentRfc =
      parent.rfcMessageId === null ? null : normalizeRfcMessageId(parent.rfcMessageId);
    const parentReferences = [];
    for (const value of parent.references) {
      const normalized = normalizeRfcMessageId(value);
      if (normalized !== null) {
        parentReferences.push(normalized);
      }
    }
    const references =
      parentRfc === null ? [] : buildOutboundReferences(parentRfc, parentReferences);
    const to = nonEmptyContacts(plan.to);
    if (to === null) {
      return yield* new ApiProblem({ message: "At least one recipient is required." });
    }
    return {
      to,
      cc: plan.cc,
      inReplyToHeader: parent.rfcMessageId,
      referencesHeader: references.length === 0 ? null : joinRfcMessageIds(references),
    };
  });
}

function submitPrepared(
  deps: ApiDeps,
  prepared: PreparedOutbound,
  requester: OutboundRequester,
  requestId: SubmissionRequestId,
  nowIso: string,
): Effect.Effect<SubmitOutboundResult, StoreMappedError> {
  const base = submitInput(deps.mailDomain, prepared, requester, requestId, nowIso);
  return Effect.gen(function* () {
    const first = yield* Effect.result(deps.account.submitOutbound(base));
    if (Result.isSuccess(first)) {
      return first.success;
    }
    if (
      first.failure._tag === "JobAuthorizationError" &&
      first.failure.reason === "approval_material_required"
    ) {
      const approval = yield* createApprovalMaterial(deps, requester, requestId, nowIso);
      return yield* deps.account
        .submitOutbound(
          submitInput(deps.mailDomain, prepared, requester, requestId, nowIso, approval),
        )
        .pipe(Effect.mapError(mapStoreError));
    }
    return yield* Effect.fail(mapStoreError(first.failure));
  });
}

function nonEmptyContacts(
  contacts: ReadonlyArray<MailContact>,
): readonly [MailContact, ...Array<MailContact>] | null {
  const first = contacts[0];
  if (first === undefined) {
    return null;
  }
  return [first, ...contacts.slice(1)];
}

type SubmitOutboundDraft = {
  requestId: SubmissionRequestId;
  requester: OutboundRequester;
  mailboxId: string;
  mailDomain: MailDomain;
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  hasRemoteImages: boolean;
  to: PreparedOutbound["to"];
  cc: PreparedOutbound["cc"];
  inReplyToHeader: string | null;
  referencesHeader: string | null;
  nowIso: string;
  approval?: ApprovalCapabilityWrite;
};

function submitInput(
  mailDomain: MailDomain,
  prepared: PreparedOutbound,
  requester: OutboundRequester,
  requestId: SubmissionRequestId,
  nowIso: string,
  approval?: ApprovalCapabilityWrite,
): SubmitOutboundInput {
  const input: SubmitOutboundDraft = {
    requestId,
    requester,
    mailboxId: prepared.mailboxId,
    mailDomain,
    subject: prepared.subject,
    textBody: prepared.textBody,
    htmlBody: prepared.htmlBody,
    hasRemoteImages: prepared.hasRemoteImages,
    to: prepared.to,
    cc: prepared.cc,
    inReplyToHeader: prepared.inReplyToHeader,
    referencesHeader: prepared.referencesHeader,
    nowIso,
  };
  if (approval !== undefined) {
    input.approval = approval;
  }
  return input;
}

function createApprovalMaterial(
  deps: ApiDeps,
  requester: OutboundRequester,
  requestId: SubmissionRequestId,
  nowIso: string,
): Effect.Effect<ApprovalCapabilityWrite, ApiProblem> {
  return Effect.gen(function* () {
    const token = deps.notification.nextToken();
    const tokenHash = yield* Effect.promise(() => hashApprovalToken(token));
    const expiresAt = DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(nowIso), { hours: APPROVAL_TTL_HOURS }),
    );
    const encrypted = yield* Effect.tryPromise({
      try: () =>
        encryptNotificationPayload(
          { version: 1, token, expiresAt },
          notificationIdentity(requester.clientId, approvalNotificationIdempotencyKey(requestId)),
          deps.notification.keyring,
        ),
      catch: () => new ApiProblem({ message: "Could not prepare the approval request." }),
    });
    return {
      tokenHash,
      expiresAt,
      notification: encryptedNotificationWrite(encrypted),
    };
  });
}

function encryptedNotificationWrite(encrypted: {
  readonly keyVersion: string;
  readonly nonce: string;
  readonly ciphertext: string;
}) {
  return {
    keyVersion: encrypted.keyVersion,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
  };
}

function sanitizeOutboundHtml(deps: ApiDeps, suppliedHtml: string | null) {
  if (suppliedHtml === null) {
    return Effect.succeed(null);
  }
  return deps.htmlPolicy
    .sanitizeForStorage(suppliedHtml, { messageId: crypto.randomUUID(), attachments: [] })
    .pipe(Effect.mapError(() => new ApiProblem({ message: HTML_BODY_VALIDATION_PROBLEM })));
}

type ComposeSubmitDraft = {
  intent: "compose";
  requestId: SubmissionRequestId;
  fromAddressId: string;
  subject: string;
  to: ComposeMessagePayload["to"];
  cc?: ComposeMessagePayload["cc"];
  text?: string;
  html?: string;
};

type ReplySubmitDraft = {
  intent: "reply";
  requestId: SubmissionRequestId;
  fromAddressId: string;
  subject: string;
  replyToMessageId: string;
  replyMode: "reply" | "reply-all";
  text?: string;
  html?: string;
};

function toSubmitPayload(
  payload: SendMessagePayload,
  requestId: SubmissionRequestId,
): SubmitMessagePayload {
  if (payload.intent === "compose") {
    const draft: ComposeSubmitDraft = {
      intent: "compose",
      requestId,
      fromAddressId: payload.fromAddressId,
      subject: payload.subject,
      to: payload.to,
    };
    if (payload.cc !== undefined) {
      draft.cc = payload.cc;
    }
    if (payload.text !== undefined) {
      draft.text = payload.text;
    }
    if (payload.html !== undefined) {
      draft.html = payload.html;
    }
    return Schema.decodeUnknownSync(SubmitMessagePayload)(draft);
  }
  const draft: ReplySubmitDraft = {
    intent: "reply",
    requestId,
    fromAddressId: payload.fromAddressId,
    subject: payload.subject,
    replyToMessageId: payload.replyToMessageId,
    replyMode: payload.replyMode,
  };
  if (payload.text !== undefined) {
    draft.text = payload.text;
  }
  if (payload.html !== undefined) {
    draft.html = payload.html;
  }
  return Schema.decodeUnknownSync(SubmitMessagePayload)(draft);
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

type ThreadListQueryDraft = {
  mailboxScope: ReturnType<typeof mailboxScopeOf>;
  mailDomain: MailDomain;
  limit?: number;
  cursor?: ThreadListCursor;
};

function threadListQuery(
  principal: Principal,
  mailDomain: MailDomain,
  limit: number | undefined,
  cursor: ThreadListCursor | undefined,
): ListThreadSummariesQuery {
  const query: ThreadListQueryDraft = {
    mailboxScope: mailboxScopeOf(principal),
    mailDomain,
  };
  if (limit !== undefined) {
    query.limit = limit;
  }
  if (cursor !== undefined) {
    query.cursor = cursor;
  }
  return query;
}

type ThreadMessageListQueryDraft = {
  mailboxScope: ReturnType<typeof mailboxScopeOf>;
  limit?: number;
  cursor?: MessageListCursor;
};

function threadMessageListQuery(
  principal: Principal,
  limit: number | undefined,
  cursor: MessageListCursor | undefined,
): ListThreadMessageSummariesQuery {
  const query: ThreadMessageListQueryDraft = {
    mailboxScope: mailboxScopeOf(principal),
  };
  if (limit !== undefined) {
    query.limit = limit;
  }
  if (cursor !== undefined) {
    query.cursor = cursor;
  }
  return query;
}

type MessageListQueryDraft = {
  mailboxScope: ReturnType<typeof mailboxScopeOf>;
  direction?: "inbound" | "outbound";
  addressId?: string;
  since?: string;
  unread?: boolean;
  limit?: number;
  cursor?: MessageListCursor;
};

function messageListQuery(
  principal: Principal,
  query: ListMessagesQuery,
  cursor: MessageListCursor | undefined,
): ListMessageSummariesQuery {
  const listQuery: MessageListQueryDraft = {
    mailboxScope: mailboxScopeOf(principal),
  };
  if (query.direction !== undefined) {
    listQuery.direction = query.direction;
  }
  if (query.addressId !== undefined) {
    listQuery.addressId = query.addressId;
  }
  if (query.since !== undefined) {
    listQuery.since = query.since;
  }
  if (query.unread !== undefined) {
    listQuery.unread = query.unread;
  }
  if (query.limit !== undefined) {
    listQuery.limit = query.limit;
  }
  if (cursor !== undefined) {
    listQuery.cursor = cursor;
  }
  return listQuery;
}

type JobListQueryDraft = {
  viewer: JobViewer;
  limit?: number;
  cursor?: JobListCursor;
};

function jobListQuery(
  principal: Principal,
  limit: number | undefined,
  cursor: JobListCursor | undefined,
): ListOutboundJobsQuery {
  const query: JobListQueryDraft = {
    viewer: jobViewer(principal),
  };
  if (limit !== undefined) {
    query.limit = limit;
  }
  if (cursor !== undefined) {
    query.cursor = cursor;
  }
  return query;
}

export function listMcpClients(deps: ApiDeps) {
  return Effect.gen(function* () {
    const policies = yield* deps.account.listMcpOAuthPolicies().pipe(Effect.mapError(mapReadError));
    return policies.map(projectMcpClient);
  });
}

export function getMcpClient(deps: ApiDeps, clientId: string) {
  return Effect.gen(function* () {
    const policy = yield* deps.account
      .getMcpOAuthPolicy(clientId)
      .pipe(Effect.mapError(mapReadError));
    if (policy === null) {
      return yield* new HttpApiError.NotFound();
    }
    return projectMcpClient(policy);
  });
}

export function setMcpClientPolicy(
  deps: ApiDeps,
  clientId: string,
  payload: UpdateMcpClientPolicyPayload,
) {
  return Effect.gen(function* () {
    const existing = yield* deps.account
      .getMcpOAuthPolicy(clientId)
      .pipe(Effect.mapError(mapReadError));
    if (existing === null) {
      return yield* new HttpApiError.NotFound();
    }
    if (existing.state === "revoked") {
      return yield* new ApiProblem({ message: "Revoked access cannot be restored." });
    }
    const label = payload.label.trim();
    if (label.length === 0) {
      return yield* new ApiProblem({ message: "Client label is required." });
    }
    const updatedAt = yield* currentIso(deps);
    yield* deps.account
      .updateMcpOAuthPolicy({ clientId, label, policy: payload.policy, updatedAt })
      .pipe(Effect.mapError(mapReadError));
    const stored = yield* deps.account
      .setMcpOAuthPolicyState({
        clientId,
        state: payload.active ? "active" : "disabled",
        updatedAt,
      })
      .pipe(Effect.mapError(mapReadError));
    if (stored === null) {
      return yield* new HttpApiError.NotFound();
    }
    return projectMcpClient(stored);
  });
}

function currentIso(deps: ApiDeps) {
  return Effect.map(deps.approvalClock.now, DateTime.formatIso);
}

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

function mapReadError(error: AccountStoreError): StoreReadError {
  switch (error._tag) {
    case "ThreadHandleError":
      return new HttpApiError.NotFound();
    case "JobAuthorizationError":
      return new HttpApiError.Forbidden();
    default:
      return new HttpApiError.BadRequest();
  }
}

function mapStoreError(error: AccountStoreError): StoreMappedError {
  if (error._tag === "SubmissionConflictError") {
    return new HttpApiError.Conflict();
  }
  if (error._tag === "JobAuthorizationError") {
    return new HttpApiError.Forbidden();
  }
  if (error._tag === "ThreadHandleError") {
    return new HttpApiError.NotFound();
  }
  if (error._tag === "QueryInputError") {
    return new HttpApiError.BadRequest();
  }
  return new ApiProblem({ message: "Could not complete the request." });
}

function decodeThreadCursor(
  cursor: string | undefined,
): Effect.Effect<ThreadListCursor | undefined, HttpApiError.BadRequest> {
  if (cursor === undefined) {
    return Effect.succeed(undefined);
  }
  const decoded = decodePairCursor(cursor);
  if (decoded === null) {
    return new HttpApiError.BadRequest();
  }
  return Effect.succeed({ lastActivityAt: decoded.left, threadHandle: decoded.right });
}

function encodeThreadCursor(lastActivityAt: string, threadHandle: string): string {
  return encodePairCursor(lastActivityAt, threadHandle);
}

function decodeMessageCursor(
  cursor: string | undefined,
): Effect.Effect<MessageListCursor | undefined, HttpApiError.BadRequest> {
  if (cursor === undefined) {
    return Effect.succeed(undefined);
  }
  const decoded = decodePairCursor(cursor);
  if (decoded === null) {
    return new HttpApiError.BadRequest();
  }
  return Effect.succeed({ occurredAt: decoded.left, id: decoded.right });
}

function encodeOptionalMessageCursor(cursor: MessageListCursor | null): string | null {
  if (cursor === null) {
    return null;
  }
  return encodePairCursor(cursor.occurredAt, cursor.id);
}

function decodeJobCursor(
  cursor: string | undefined,
): Effect.Effect<JobListCursor | undefined, HttpApiError.BadRequest> {
  if (cursor === undefined) {
    return Effect.succeed(undefined);
  }
  const decoded = decodePairCursor(cursor);
  if (decoded === null) {
    return new HttpApiError.BadRequest();
  }
  return Effect.succeed({ createdAt: decoded.left, jobId: decoded.right });
}

function encodeJobCursor(createdAt: string, jobId: string): string {
  return encodePairCursor(createdAt, jobId);
}

function decodePairCursor(cursor: string): { left: string; right: string } | null {
  const decoded = Encoding.decodeBase64UrlString(cursor);
  if (Result.isFailure(decoded)) {
    return null;
  }
  const separator = decoded.success.indexOf("\n");
  if (separator <= 0 || separator !== decoded.success.lastIndexOf("\n")) {
    return null;
  }
  const left = decoded.success.slice(0, separator);
  const right = decoded.success.slice(separator + 1);
  const timestamp = new Date(left);
  if (right.length === 0 || Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== left) {
    return null;
  }
  return { left, right };
}

function encodePairCursor(left: string, right: string): string {
  return Encoding.encodeBase64Url(`${left}\n${right}`);
}
