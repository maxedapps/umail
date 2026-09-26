import type {
  MessageBody,
  MessageSummary,
  OutboundJob,
  ThreadSummary,
  AccountMailContact,
} from "../account/domain.ts";
import {
  AttachmentMeta,
  ExternalMailAddress,
  InboundMailMessageSummary,
  InboundThreadMessage,
  MailContact,
  MailThreadSummary,
  OutboundJobStatus,
  OutboundMailMessageSummary,
  OutboundThreadMessage,
  SendingIdentity,
  ThreadParty,
  type MailMessageSummary,
} from "@umail/api-contract";

const UNKNOWN_EXTERNAL = ExternalMailAddress.make("unknown@invalid");

export function projectThreadSummary(summary: ThreadSummary): MailThreadSummary {
  return new MailThreadSummary({
    threadId: summary.threadId,
    subject: summary.subject,
    latestSender: projectLatestSender(summary.latestSender),
    latestRecipients: summary.latestRecipients.map(projectParticipantParty),
    unreadCount: summary.unreadCount,
    messageCount: summary.messageCount,
    involvedMailboxIdentities: summary.involvedMailboxIdentities.map(
      (identity) => new SendingIdentity(identity),
    ),
    lastActivityAt: summary.lastActivityAt,
  });
}

export function projectMessageSummary(summary: MessageSummary): MailMessageSummary {
  const fields = messageSummaryFields(summary);
  return fields.direction === "inbound"
    ? new InboundMailMessageSummary(fields)
    : new OutboundMailMessageSummary(fields);
}

export function projectThreadMessage(
  summary: MessageSummary,
  body: MessageBody,
): InboundThreadMessage | OutboundThreadMessage {
  const fields = messageSummaryFields(summary);
  const bodies = { textBody: body.textBody, htmlBody: body.htmlBody };
  return fields.direction === "inbound"
    ? new InboundThreadMessage({ ...fields, ...bodies })
    : new OutboundThreadMessage({ ...fields, ...bodies });
}

function messageSummaryFields(summary: MessageSummary) {
  const common = {
    id: summary.id,
    threadId: summary.threadId,
    parentMessageId: summary.parentMessageId,
    addressId: summary.mailboxId,
    subject: summary.subject,
    occurredAt: summary.occurredAt,
    ...projectParticipants(summary),
    hasRemoteImages: summary.hasRemoteImages,
    rfcMessageId: summary.rfcMessageId,
    inReplyToRfcMessageId: summary.inReplyToRfcMessageId,
    references: summary.references,
    attachments: summary.attachments.map((meta) => new AttachmentMeta(meta)),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt ?? summary.createdAt,
  };
  if (summary.direction === "inbound") {
    return {
      ...common,
      direction: "inbound",
      envelopeFrom: summary.envelopeFrom,
      envelopeTo: summary.envelopeTo,
      parsedDate: summary.parsedDate,
      isRead: summary.isRead,
      readAt: summary.readAt,
      forwardOutcome: summary.forwardOutcome,
      forwardDestination: summary.forwardDestination,
    } as const;
  }
  const job = summary.outboundJob;
  return {
    ...common,
    direction: "outbound",
    sendState: job.state,
    sendError: sendError(job.failureClass, job.failureDetail),
    providerMessageId: job.providerMessageId,
  } as const;
}

// "provider: E_VALIDATION_ERROR: bad sender"; an unknown outcome has a detail but no class.
function sendError(failureClass: string | null, failureDetail: string | null): string | null {
  if (failureDetail === null) return failureClass;
  return failureClass === null ? failureDetail : `${failureClass}: ${failureDetail}`;
}

export function projectJobStatus(job: OutboundJob): OutboundJobStatus {
  return new OutboundJobStatus({
    jobId: job.jobId,
    requestId: job.requestId,
    messageId: job.messageId,
    threadId: job.threadId,
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

function projectParticipants(summary: MessageSummary) {
  return {
    from: summary.from.map(projectMailContact),
    replyTo: summary.replyTo.map(projectMailContact),
    to: summary.to.map(projectMailContact),
    cc: summary.cc.map(projectMailContact),
  };
}

function projectMailContact(contact: AccountMailContact): MailContact {
  return new MailContact(contact);
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
