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
    threadId: summary.threadHandle,
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
  const threadId = summary.threadHandle;
  const contacts = projectParticipants(summary);
  const attachments = summary.attachments.map((meta) => new AttachmentMeta(meta));
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
      rfcMessageId: summary.rfcMessageId,
      inReplyToRfcMessageId: summary.inReplyToRfcMessageId,
      references: summary.references,
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
      forwardOutcome: summary.forwardOutcome,
      forwardDestination: summary.forwardDestination,
    });
  }
  const job = summary.outboundJob;
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
    rfcMessageId: summary.rfcMessageId,
    inReplyToRfcMessageId: summary.inReplyToRfcMessageId,
    references: summary.references,
    attachments,
    createdAt: summary.createdAt,
    updatedAt,
    sendState: job.state,
    sendError: job.failureClass,
    providerMessageId: job.providerMessageId,
  });
}

export function projectThreadMessage(
  summary: MessageSummary,
  body: MessageBody,
): InboundThreadMessage | OutboundThreadMessage {
  const projected = projectMessageSummary(summary);
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
    threadHandle: job.threadHandle,
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
