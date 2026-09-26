import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import { Conflict, NotFound, RequestErrors, Unavailable } from "./errors.ts";
import { ExternalMailAddress, MailContact } from "./mail-contact.ts";
import { MailboxAddress } from "./mailbox-address.ts";
import { NormalizedRfcMessageId } from "./message-threading.ts";
import { PrincipalAuthorization } from "./principal-authorization.ts";
import { UtcInstant } from "./query-instant.ts";
import {
  OutboundJobFailureClass,
  OutboundJobPurpose,
  OutboundJobState,
  SubmissionRequestId,
} from "./submission-domain.ts";

export class Address extends Schema.Class<Address>("Address")({
  id: Schema.String,
  localPart: Schema.String,
  address: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  forwardTo: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class SendingIdentity extends Schema.Class<SendingIdentity>("SendingIdentity")({
  id: Schema.String,
  address: MailboxAddress,
  displayName: Schema.NullOr(Schema.String),
}) {}

export class AttachmentMeta extends Schema.Class<AttachmentMeta>("AttachmentMeta")({
  id: Schema.String,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Finite,
  contentId: Schema.NullOr(Schema.String),
  disposition: Schema.NullOr(Schema.String),
  isInline: Schema.Boolean,
}) {}

export class ThreadParty extends Schema.Class<ThreadParty>("ThreadParty")({
  source: Schema.Literals(["participant", "envelope"]),
  contact: MailContact,
}) {}

const mailMessageSummaryFields = {
  id: Schema.String,
  threadId: Schema.String,
  parentMessageId: Schema.NullOr(Schema.String),
  addressId: Schema.String,
  subject: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
  from: Schema.Array(MailContact),
  replyTo: Schema.Array(MailContact),
  to: Schema.Array(MailContact),
  cc: Schema.Array(MailContact),
  hasRemoteImages: Schema.Boolean,
  rfcMessageId: Schema.NullOr(NormalizedRfcMessageId),
  inReplyToRfcMessageId: Schema.NullOr(NormalizedRfcMessageId),
  references: Schema.Array(NormalizedRfcMessageId),
  attachments: Schema.Array(AttachmentMeta),
  createdAt: Schema.String,
  updatedAt: Schema.String,
};

const inboundMessageStateFields = {
  envelopeFrom: Schema.String,
  envelopeTo: Schema.String,
  parsedDate: Schema.NullOr(UtcInstant),
  isRead: Schema.Boolean,
  readAt: Schema.NullOr(Schema.String),
  forwardOutcome: Schema.Literals(["none", "unknown", "success", "failure"]),
  forwardDestination: Schema.NullOr(Schema.String),
};

const outboundMessageStateFields = {
  sendState: OutboundJobState,
  sendError: Schema.NullOr(Schema.String),
  providerMessageId: Schema.NullOr(Schema.String),
};

const threadMessageFields = {
  ...mailMessageSummaryFields,
  textBody: Schema.NullOr(Schema.String),
  htmlBody: Schema.NullOr(Schema.String),
};

export class InboundMailMessageSummary extends Schema.Class<InboundMailMessageSummary>(
  "InboundMailMessageSummary",
)({
  direction: Schema.Literal("inbound"),
  ...mailMessageSummaryFields,
  ...inboundMessageStateFields,
}) {}

export class OutboundMailMessageSummary extends Schema.Class<OutboundMailMessageSummary>(
  "OutboundMailMessageSummary",
)({
  direction: Schema.Literal("outbound"),
  ...mailMessageSummaryFields,
  ...outboundMessageStateFields,
}) {}

export const MailMessageSummary = Schema.Union([
  InboundMailMessageSummary,
  OutboundMailMessageSummary,
]);
export type MailMessageSummary = typeof MailMessageSummary.Type;

export class InboundThreadMessage extends Schema.Class<InboundThreadMessage>(
  "InboundThreadMessage",
)({
  direction: Schema.Literal("inbound"),
  ...threadMessageFields,
  ...inboundMessageStateFields,
}) {}

export class OutboundThreadMessage extends Schema.Class<OutboundThreadMessage>(
  "OutboundThreadMessage",
)({
  direction: Schema.Literal("outbound"),
  ...threadMessageFields,
  ...outboundMessageStateFields,
}) {}

export const ThreadMessage = Schema.Union([InboundThreadMessage, OutboundThreadMessage]);
export type ThreadMessage = typeof ThreadMessage.Type;

export class MessageHeaders extends Schema.Class<MessageHeaders>("MessageHeaders")({
  headers: Schema.String,
  truncated: Schema.Boolean,
}) {}

export class MailThreadSummary extends Schema.Class<MailThreadSummary>("MailThreadSummary")({
  threadId: Schema.String,
  subject: Schema.NullOr(Schema.String),
  latestSender: ThreadParty,
  latestRecipients: Schema.Array(ThreadParty),
  unreadCount: Schema.Finite,
  messageCount: Schema.Finite,
  involvedMailboxIdentities: Schema.Array(SendingIdentity),
  lastActivityAt: Schema.String,
}) {}

export class MailThreadPage extends Schema.Class<MailThreadPage>("MailThreadPage")({
  items: Schema.Array(MailThreadSummary),
  nextCursor: Schema.NullOr(Schema.String),
}) {}

export class MailThreadDetail extends Schema.Class<MailThreadDetail>("MailThreadDetail")({
  threadId: Schema.String,
  messages: Schema.Array(MailMessageSummary),
  nextCursor: Schema.NullOr(Schema.String),
}) {}

export class MailMessagePage extends Schema.Class<MailMessagePage>("MailMessagePage")({
  items: Schema.Array(MailMessageSummary),
  nextCursor: Schema.NullOr(Schema.String),
}) {}

export class ListThreadsQuery extends Schema.Class<ListThreadsQuery>("ListThreadsQuery")({
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(Schema.String),
}) {}

export class ListMessagesQuery extends Schema.Class<ListMessagesQuery>("ListMessagesQuery")({
  direction: Schema.optionalKey(Schema.Literals(["inbound", "outbound"])),
  addressId: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(UtcInstant),
  unread: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(Schema.String),
}) {}

export class ListThreadMessagesQuery extends Schema.Class<ListThreadMessagesQuery>(
  "ListThreadMessagesQuery",
)({
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(Schema.String),
}) {}

const messageFields = {
  requestId: SubmissionRequestId.annotate({
    description:
      "A UUID you generate for this message (any case). To retry, resend the same requestId with the same content: you get the existing job and the message is never sent twice. Use a new requestId for a new message.",
  }).pipe(Schema.annotateKey({ messageMissingKey: "Expected a requestId (a UUID you generate)" })),
  fromAddressId: Schema.String,
  subject: Schema.String,
  text: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
};

export const composeFields = {
  ...messageFields,
  to: Schema.NonEmptyArray(
    MailContact.pipe(Schema.annotateKey({ messageMissingKey: "Expected at least one recipient" })),
  ),
  cc: Schema.optionalKey(Schema.Array(MailContact)),
};

export const replyFields = {
  ...messageFields,
  replyToMessageId: Schema.String.annotate({ description: "Id of the message being answered." }),
  replyMode: Schema.Literals(["reply", "reply-all"]),
};

export const hasMessageBody = Schema.makeFilter(
  (payload: { readonly text?: string; readonly html?: string }) =>
    (payload.text ?? "").length > 0 || (payload.html ?? "").length > 0
      ? undefined
      : "A message body is required.",
);

export class ComposeSubmissionPayload extends Schema.Class<ComposeSubmissionPayload>(
  "ComposeSubmissionPayload",
)({
  intent: Schema.Literal("compose"),
  ...composeFields,
}) {}

export class ReplySubmissionPayload extends Schema.Class<ReplySubmissionPayload>(
  "ReplySubmissionPayload",
)({
  intent: Schema.Literal("reply"),
  ...replyFields,
}) {}

export const SubmitMessagePayload = Schema.Union([
  ComposeSubmissionPayload.check(hasMessageBody),
  ReplySubmissionPayload.check(hasMessageBody),
]).annotate({ expected: 'a compose or reply submission (intent: "compose" | "reply")' });
export type SubmitMessagePayload = typeof SubmitMessagePayload.Type;

export class OutboundJobStatus extends Schema.Class<OutboundJobStatus>("OutboundJobStatus")({
  jobId: Schema.String,
  requestId: Schema.String.check(Schema.isMinLength(1)),
  messageId: Schema.String,
  threadId: Schema.String,
  state: OutboundJobState,
  purpose: OutboundJobPurpose,
  attemptId: Schema.NullOr(Schema.String),
  providerMessageId: Schema.NullOr(Schema.String),
  rfcMessageId: Schema.NullOr(Schema.String),
  failureClass: Schema.NullOr(OutboundJobFailureClass),
  failureDetail: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class ListJobsQuery extends Schema.Class<ListJobsQuery>("ListJobsQuery")({
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(Schema.String),
}) {}

export class OutboundJobStatusPage extends Schema.Class<OutboundJobStatusPage>(
  "OutboundJobStatusPage",
)({
  items: Schema.Array(OutboundJobStatus),
  nextCursor: Schema.NullOr(Schema.String),
}) {}

export class CreateAddressPayload extends Schema.Class<CreateAddressPayload>(
  "CreateAddressPayload",
)({
  localPart: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
}) {}

export class PatchAddressPayload extends Schema.Class<PatchAddressPayload>("PatchAddressPayload")({
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  active: Schema.optionalKey(Schema.Boolean),
}) {}

export class SetForwardingPayload extends Schema.Class<SetForwardingPayload>(
  "SetForwardingPayload",
)({
  email: ExternalMailAddress,
}) {}

// Cloudflare only forwards to a verified destination; it emails the owner a link until then.
export class AddressForwarding extends Schema.Class<AddressForwarding>("AddressForwarding")({
  address: Address,
  verified: Schema.Boolean,
}) {}

const IdParams = Schema.Struct({
  id: Schema.String,
});

const AttachmentParams = Schema.Struct({
  id: Schema.String,
  attachmentId: Schema.String,
});

// Every store call can fail with these; the policy and request errors come from the API's
// middlewares (PrincipalAuthorization, RequestErrors).
const storeErrors = [NotFound, Conflict] as const;

class AddressesGroup extends HttpApiGroup.make("Addresses")
  .add(
    HttpApiEndpoint.post("createAddress", "/addresses", {
      payload: CreateAddressPayload,
      success: Address,
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listAddresses", "/addresses", {
      success: Schema.Array(Address),
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getAddress", "/addresses/:id", {
      params: IdParams,
      success: Address,
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("patchAddress", "/addresses/:id", {
      params: IdParams,
      payload: PatchAddressPayload,
      success: Address,
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put("setForwarding", "/addresses/:id/forwarding", {
      params: IdParams,
      payload: SetForwardingPayload,
      success: AddressForwarding,
      error: [...storeErrors, Unavailable],
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeForwarding", "/addresses/:id/forwarding", {
      params: IdParams,
      success: Address,
      error: storeErrors,
    }),
  ) {}

class SendingIdentitiesGroup extends HttpApiGroup.make("SendingIdentities").add(
  HttpApiEndpoint.get("listSendingIdentities", "/sending-identities", {
    success: Schema.Array(SendingIdentity),
    error: storeErrors,
  }),
) {}

class ThreadsGroup extends HttpApiGroup.make("Threads")
  .add(
    HttpApiEndpoint.get("listThreads", "/threads", {
      query: ListThreadsQuery,
      success: MailThreadPage,
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getThread", "/threads/:id", {
      params: IdParams,
      query: ListThreadMessagesQuery,
      success: MailThreadDetail,
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("markThreadRead", "/threads/:id/read", {
      params: IdParams,
      success: MailThreadDetail,
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("markThreadUnread", "/threads/:id/unread", {
      params: IdParams,
      success: MailThreadDetail,
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("softDeleteThread", "/threads/:id", {
      params: IdParams,
      success: HttpApiSchema.NoContent,
      error: storeErrors,
    }),
  ) {}

class MessagesGroup extends HttpApiGroup.make("Messages")
  .add(
    HttpApiEndpoint.get("listMessages", "/messages", {
      query: ListMessagesQuery,
      success: MailMessagePage,
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getMessage", "/messages/:id", {
      params: IdParams,
      success: ThreadMessage,
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getAttachment", "/messages/:id/attachments/:attachmentId", {
      params: AttachmentParams,
      success: HttpApiSchema.WithHeaders(Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()), {
        "content-type": Schema.String,
        "content-disposition": Schema.String,
        "x-content-type-options": Schema.String,
        "content-security-policy": Schema.optionalKey(Schema.String),
      }),
      error: [...storeErrors, Unavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("getMessageSource", "/messages/:id/source", {
      params: IdParams,
      success: HttpApiSchema.WithHeaders(Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()), {
        "content-type": Schema.String,
        "content-disposition": Schema.String,
        "x-content-type-options": Schema.String,
      }),
      error: [...storeErrors, Unavailable],
    }),
  ) {}

class SubmissionsGroup extends HttpApiGroup.make("Submissions").add(
  HttpApiEndpoint.post("submitMessage", "/submissions", {
    payload: SubmitMessagePayload,
    success: OutboundJobStatus,
    error: storeErrors,
  }),
) {}

class JobsGroup extends HttpApiGroup.make("Jobs")
  .add(
    HttpApiEndpoint.get("listJobs", "/jobs", {
      query: ListJobsQuery,
      success: OutboundJobStatusPage,
      error: storeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getJob", "/jobs/:id", {
      params: IdParams,
      success: OutboundJobStatus,
      error: storeErrors,
    }),
  ) {}

const ApprovalTokenParams = Schema.Struct({
  token: Schema.String,
});

export const ApprovalDecisionState = Schema.Literals([
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export type ApprovalDecisionState = typeof ApprovalDecisionState.Type;

const ApprovalHtmlBody = Schema.String.pipe(
  HttpApiSchema.asText({ contentType: "text/html; charset=utf-8" }),
);

export const ApprovalTrustedPageHeaders = Schema.Struct({
  "cache-control": Schema.Literal("no-store"),
  "content-security-policy": Schema.String,
  "content-type": Schema.Literal("text/html; charset=utf-8"),
  "permissions-policy": Schema.String,
  "referrer-policy": Schema.Literal("no-referrer"),
  "x-content-type-options": Schema.Literal("nosniff"),
  "x-frame-options": Schema.Literal("DENY"),
  "x-robots-tag": Schema.Literal("noindex, nofollow, noarchive"),
});

export const ApprovalPreviewHeaders = Schema.Struct({
  "cache-control": Schema.Literal("no-store"),
  "content-security-policy": Schema.String,
  "content-type": Schema.Literal("text/html; charset=utf-8"),
  "referrer-policy": Schema.Literal("no-referrer"),
  "x-content-type-options": Schema.Literal("nosniff"),
});

const ApprovalRedirectHeaders = Schema.Struct({
  location: Schema.String,
  "x-umail-approval-state": ApprovalDecisionState,
  "cache-control": Schema.Literal("no-store"),
  "referrer-policy": Schema.Literal("no-referrer"),
});

const ApprovalTrustedPage = HttpApiSchema.WithHeaders(ApprovalHtmlBody, ApprovalTrustedPageHeaders);

const ApprovalMessagePreview = HttpApiSchema.WithHeaders(ApprovalHtmlBody, ApprovalPreviewHeaders);

const ApprovalDecisionRedirect = HttpApiSchema.WithHeaders(
  HttpApiSchema.Empty(303),
  ApprovalRedirectHeaders,
);

export class ApprovalPageNotFound extends Schema.TaggedError<ApprovalPageNotFound>()(
  "ApprovalPageNotFound",
  {
    html: Schema.String,
    headers: ApprovalTrustedPageHeaders,
  },
) {}

export class ApprovalPageGone extends Schema.TaggedError<ApprovalPageGone>()("ApprovalPageGone", {
  html: Schema.String,
  headers: ApprovalTrustedPageHeaders,
}) {}

const ApprovalPageNotFoundResponse = ApprovalPageNotFound.pipe(
  HttpApiSchema.encodeToWithHeaders(
    {
      body: ApprovalHtmlBody.pipe(HttpApiSchema.status(404)),
      headers: ApprovalTrustedPageHeaders.fields,
    },
    {
      decode: ({ body, headers }) => new ApprovalPageNotFound({ html: body, headers }),
      encode: (error) => ({ body: error.html, headers: error.headers }),
    },
  ),
);

const ApprovalPageGoneResponse = ApprovalPageGone.pipe(
  HttpApiSchema.encodeToWithHeaders(
    {
      body: ApprovalHtmlBody.pipe(HttpApiSchema.status(410)),
      headers: ApprovalTrustedPageHeaders.fields,
    },
    {
      decode: ({ body, headers }) => new ApprovalPageGone({ html: body, headers }),
      encode: (error) => ({ body: error.html, headers: error.headers }),
    },
  ),
);

const approvalErrors = [ApprovalPageNotFoundResponse, ApprovalPageGoneResponse] as const;

class PublicApprovalsGroup extends HttpApiGroup.make("PublicApprovals")
  .add(
    HttpApiEndpoint.get("reviewApproval", "/approvals/:token", {
      params: ApprovalTokenParams,
      success: ApprovalTrustedPage,
      error: approvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("previewApprovalMessage", "/approvals/:token/message", {
      params: ApprovalTokenParams,
      success: ApprovalMessagePreview,
      error: approvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("approveApproval", "/approvals/:token/approve", {
      params: ApprovalTokenParams,
      success: ApprovalDecisionRedirect,
      error: approvalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("denyApproval", "/approvals/:token/deny", {
      params: ApprovalTokenParams,
      success: ApprovalDecisionRedirect,
      error: approvalErrors,
    }),
  ) {}

export class PublicApprovalApi extends HttpApi.make("PublicApprovalApi").add(
  PublicApprovalsGroup,
) {}

export class UmailApi extends HttpApi.make("UmailApi")
  .add(AddressesGroup)
  .add(SendingIdentitiesGroup)
  .add(ThreadsGroup)
  .add(MessagesGroup)
  .add(SubmissionsGroup)
  .add(JobsGroup)
  .middleware(PrincipalAuthorization)
  .middleware(RequestErrors) {}
