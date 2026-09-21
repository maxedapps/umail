import {
  AccountAddress,
  AccountDestination,
  McpOAuthPolicy,
  AccountSendingIdentity,
  MAX_OUTBOUND_RECIPIENTS,
  MessageBody,
  MessageSummary,
  OutboundJob,
  QUERY_PAGE_DEFAULT,
  QUERY_PAGE_MAX,
  ThreadSummary,
  type AccountMailContact,
  type AccountAttachmentMeta,
  type OutboundMessageSummary,
} from "../account/domain.ts";
import {
  Address,
  AttachmentMeta,
  ForwardingDestination,
  InboundMailMessageSummary,
  InboundThreadMessage,
  MailContact,
  MailThreadSummary,
  OutboundJobStatus,
  OutboundMailMessageSummary,
  OutboundThreadMessage,
  SendingIdentity,
  ThreadHandle,
  ThreadParty,
  normalizeRfcMessageId,
  parseExternalMailAddress,
  parseMailboxAddress,
  parseThreadHandle,
  type ExternalMailAddress,
  type MailMessageSummary,
  type NormalizedRfcMessageId,
  McpClient,
} from "@umail/api-contract";

export { MAX_OUTBOUND_RECIPIENTS, QUERY_PAGE_DEFAULT, QUERY_PAGE_MAX };

const UNKNOWN_EXTERNAL = decodeExternalAddress("unknown@invalid");
const UNKNOWN_THREAD_HANDLE = decodeThreadHandle("node:00000000-0000-4000-8000-000000000000");

export function projectAddress(address: AccountAddress): Address {
  return new Address(address);
}

export function projectDestination(destination: AccountDestination): ForwardingDestination {
  return new ForwardingDestination(destination);
}

export function projectMcpClient(policy: McpOAuthPolicy): McpClient {
  return new McpClient(policy);
}

export function projectSendingIdentity(identity: AccountSendingIdentity): SendingIdentity | null {
  const parsed = parseMailboxAddress(identity.address);
  if (parsed.kind !== "ok") {
    return null;
  }
  return new SendingIdentity({
    id: identity.id,
    address: parsed.address,
    displayName: identity.displayName,
  });
}

export function projectSendingIdentities(
  identities: ReadonlyArray<AccountSendingIdentity>,
): ReadonlyArray<SendingIdentity> {
  const projected: Array<SendingIdentity> = [];
  for (const identity of identities) {
    const sending = projectSendingIdentity(identity);
    if (sending !== null) {
      projected.push(sending);
    }
  }
  return projected;
}

export function projectThreadSummary(summary: ThreadSummary): MailThreadSummary | null {
  const threadId = requireThreadHandle(summary.threadHandle);
  if (threadId === null) {
    return null;
  }
  return new MailThreadSummary({
    threadId,
    subject: summary.subject,
    latestSender: projectLatestSender(summary.latestSender),
    latestRecipients: summary.latestRecipients.map(projectParticipantParty),
    unreadCount: summary.unreadCount,
    messageCount: summary.messageCount,
    involvedMailboxIdentities: projectSendingIdentities(summary.involvedMailboxIdentities),
    lastActivityAt: summary.lastActivityAt,
  });
}

export function projectMessageSummary(summary: MessageSummary): MailMessageSummary | null {
  const threadId = requireThreadHandle(summary.threadHandle);
  if (threadId === null) {
    return null;
  }
  const contacts = projectParticipants(summary);
  const references = projectRfcIds(summary.references);
  const attachments = summary.attachments.map(projectAttachmentMeta);
  const rfcMessageId = projectRfcId(summary.rfcMessageId);
  const inReplyToRfcMessageId = projectRfcId(summary.inReplyToRfcMessageId);
  const updatedAt = summary.updatedAt ?? summary.createdAt;
  if (summary.direction === "inbound") {
    return new InboundMailMessageSummary({
      direction: "inbound",
      id: summary.id,
      threadId,
      parentMessageId: summary.parentMessageId,
      addressId: summary.mailboxId,
      subject: summary.subject,
      occurredAt: summary.occurredAt,
      deletedAt: null,
      from: contacts.from,
      replyTo: contacts.replyTo,
      to: contacts.to,
      cc: contacts.cc,
      hasRemoteImages: summary.hasRemoteImages,
      rfcMessageId,
      inReplyToRfcMessageId,
      references,
      attachments,
      createdAt: summary.createdAt,
      updatedAt,
      envelopeFrom: summary.envelopeFrom,
      envelopeTo: summary.envelopeTo,
      parsedDate: summary.parsedDate,
      processingState: "indexed",
      processingError: null,
      isRead: summary.isRead,
      readAt: summary.readAt,
      forwardOutcome: summary.forward.kind,
      forwardDestination: summary.forward.kind === "none" ? null : summary.forward.destination,
    });
  }
  const outbound = projectOutboundJobState(summary);
  return new OutboundMailMessageSummary({
    direction: "outbound",
    id: summary.id,
    threadId,
    parentMessageId: summary.parentMessageId,
    addressId: summary.mailboxId,
    subject: summary.subject,
    occurredAt: summary.occurredAt,
    deletedAt: null,
    from: contacts.from,
    replyTo: contacts.replyTo,
    to: contacts.to,
    cc: contacts.cc,
    hasRemoteImages: summary.hasRemoteImages,
    rfcMessageId,
    inReplyToRfcMessageId,
    references,
    attachments,
    createdAt: summary.createdAt,
    updatedAt,
    sendState: outbound.sendState,
    sendError: outbound.sendError,
    providerMessageId: outbound.providerMessageId,
  });
}

function projectOutboundJobState(summary: OutboundMessageSummary) {
  const job = summary.outboundJob;
  return {
    sendState: job.state,
    sendError: job.failureClass,
    providerMessageId: job.providerMessageId,
  };
}

export function projectThreadMessage(
  summary: MessageSummary,
  body: MessageBody,
): InboundThreadMessage | OutboundThreadMessage | null {
  const projected = projectMessageSummary(summary);
  if (projected === null) {
    return null;
  }
  if (projected.direction === "inbound") {
    return new InboundThreadMessage({
      ...projected,
      textBody: body.textBody,
      htmlBody: body.htmlBody,
    });
  }
  return new OutboundThreadMessage({
    ...projected,
    textBody: body.textBody,
    htmlBody: body.htmlBody,
  });
}

export function projectJobStatus(job: OutboundJob): OutboundJobStatus {
  return new OutboundJobStatus({
    jobId: job.jobId,
    requestId: job.requestId,
    messageId: job.messageId,
    threadHandle: requireJobThreadHandle(job.threadHandle),
    state: job.state,
    purpose: job.purpose,
    attemptId: job.attemptId,
    providerMessageId: job.providerMessageId,
    rfcMessageId: job.rfcMessageId,
    failureClass: job.failureClass,
    failureDetail: job.failureDetail,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
}

export function projectAttachmentMeta(meta: AccountAttachmentMeta): AttachmentMeta {
  return new AttachmentMeta(meta);
}

function projectParticipants(summary: MessageSummary) {
  return {
    from: summary.from.map(projectMailContact),
    replyTo: summary.replyTo.map(projectMailContact),
    to: summary.to.map(projectMailContact),
    cc: summary.cc.map(projectMailContact),
  };
}

function projectMailContact(contact: AccountMailContact): MailContact {
  return new MailContact({
    address: requireExternalAddress(contact.address),
    displayName: contact.displayName,
  });
}

function projectLatestSender(contact: AccountMailContact | null): ThreadParty {
  if (contact !== null) {
    return projectParticipantParty(contact);
  }
  return new ThreadParty({
    source: "envelope",
    contact: new MailContact({ address: UNKNOWN_EXTERNAL, displayName: null }),
  });
}

function projectParticipantParty(contact: AccountMailContact): ThreadParty {
  return new ThreadParty({ source: "participant", contact: projectMailContact(contact) });
}

function projectRfcIds(values: ReadonlyArray<string>): ReadonlyArray<NormalizedRfcMessageId> {
  const ids: Array<NormalizedRfcMessageId> = [];
  for (const value of values) {
    const normalized = normalizeRfcMessageId(value);
    if (normalized !== null) {
      ids.push(normalized);
    }
  }
  return ids;
}

function projectRfcId(value: string | null): NormalizedRfcMessageId | null {
  if (value === null) {
    return null;
  }
  return normalizeRfcMessageId(value);
}

function requireThreadHandle(raw: string): ThreadHandle | null {
  const parsed = parseThreadHandle(raw);
  if (parsed.kind === "invalid") {
    return null;
  }
  return parsed.handle;
}

function requireJobThreadHandle(raw: string): ThreadHandle {
  const handle = requireThreadHandle(raw);
  if (handle === null) {
    return UNKNOWN_THREAD_HANDLE;
  }
  return handle;
}

function requireExternalAddress(raw: string): ExternalMailAddress {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind === "ok") {
    return parsed.address;
  }
  return UNKNOWN_EXTERNAL;
}

function decodeExternalAddress(raw: string): ExternalMailAddress {
  const parsed = parseExternalMailAddress(raw);
  if (parsed.kind !== "ok") {
    throw new Error(`static address ${raw} must parse`);
  }
  return parsed.address;
}

function decodeThreadHandle(raw: string): ThreadHandle {
  const parsed = parseThreadHandle(raw);
  if (parsed.kind === "invalid") {
    throw new Error(`static thread handle ${raw} must parse`);
  }
  return parsed.handle;
}
