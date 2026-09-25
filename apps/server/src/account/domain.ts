import {
  ApprovalState,
  ApprovalTokenHash,
  ExternalMailAddress,
  MailboxAddress,
  NormalizedRfcMessageId,
  OutboundJobFailureClass,
  OutboundJobPurpose,
  OutboundJobState,
  UtcInstant,
  type PrincipalPolicy,
  type SubmissionRequestId,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";

// SQLite rows (and JSON columns) are decoded with Schema; everything else here is a plain type,
// since same-deploy callers reach the DO through these TypeScript types.

export const SchemaMigrationRow = Schema.Struct({
  version: Schema.Finite,
  name: Schema.String,
});
export type SchemaMigrationRow = typeof SchemaMigrationRow.Type;

export const MessageDirection = Schema.Literals(["inbound", "outbound"]);
export type MessageDirection = typeof MessageDirection.Type;

export type MessageAttachmentWrite = {
  readonly id: string;
  readonly position: number;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly r2Key: string;
  readonly contentId: string | null;
  readonly disposition: string | null;
  readonly isInline: boolean;
};

export type AccountMailContact = {
  readonly address: ExternalMailAddress;
  readonly displayName: string | null;
};

export type AcceptOutboundInput = {
  readonly messageId: string;
  readonly mailboxId: string;
  readonly rfcMessageId: string | null;
  readonly inReplyToHeader: string | null;
  readonly referencesHeader: string | null;
  readonly occurredAt: string;
  readonly nowIso: string;
  readonly subject?: string | null;
  readonly textBody?: string | null;
  readonly htmlBody?: string | null;
  readonly hasRemoteImages?: boolean;
  readonly from?: ReadonlyArray<AccountMailContact>;
  readonly replyTo?: ReadonlyArray<AccountMailContact>;
  readonly to?: ReadonlyArray<AccountMailContact>;
  readonly cc?: ReadonlyArray<AccountMailContact>;
  readonly attachments?: ReadonlyArray<MessageAttachmentWrite>;
};

export type AcceptInboundInput = AcceptOutboundInput & {
  readonly parsedDate: string | null;
};

export type AcceptMessageResult = {
  readonly messageId: string;
  readonly threadId: string;
};

export const MessageIdPresenceRow = Schema.Struct({
  id: Schema.String,
});

export const ThreadIdRow = Schema.Struct({
  thread_id: Schema.String,
});

export const ForwardOutcome = Schema.Literals(["none", "unknown", "success", "failure"]);
export type ForwardOutcome = typeof ForwardOutcome.Type;

export const ReceiptWorkState = Schema.Literals(["ready", "indexed", "policy_failed"]);
export type ReceiptWorkState = typeof ReceiptWorkState.Type;

export const ReceiptPolicyError = Schema.Literals([
  "attachment_cap",
  "message_budget",
  "mime_budget",
  "parse_failed",
  "rfc822_depth",
]);
export type ReceiptPolicyError = typeof ReceiptPolicyError.Type;

export type InboundReceipt = {
  readonly receiptId: string;
  readonly envelopeFrom: string;
  readonly envelopeTo: string;
  readonly rawKey: string;
  readonly receivedAt: string;
  readonly forwardOutcome: ForwardOutcome;
  readonly forwardDestination: string | null;
  readonly workState: ReceiptWorkState;
  readonly policyError: ReceiptPolicyError | null;
  readonly retryAfter: string;
};

export type RegisterInboundReceiptInput = {
  readonly receiptId: string;
  readonly envelopeFrom: string;
  readonly envelopeTo: string;
  readonly rawKey: string;
  readonly receivedAt: string;
};

export type ObserveInboundForwardInput = {
  readonly receiptId: string;
  readonly observation: {
    readonly kind: Exclude<ForwardOutcome, "none">;
    readonly destination: string;
  };
};

export type FailInboundReceiptPolicyInput = {
  readonly receiptId: string;
  readonly reason: ReceiptPolicyError;
};

export const InboundReceiptRow = Schema.Struct({
  id: Schema.String,
  envelope_from: Schema.String,
  envelope_to: Schema.String,
  raw_key: Schema.String,
  received_at: Schema.String,
  forward_outcome: ForwardOutcome,
  forward_destination: Schema.NullOr(Schema.String),
  work_state: ReceiptWorkState,
  policy_error: Schema.NullOr(ReceiptPolicyError),
  retry_after: Schema.String,
});
export type InboundReceiptRow = typeof InboundReceiptRow.Type;

export const DueInboundReceiptRow = Schema.Struct({
  id: Schema.String,
  received_at: Schema.String,
});

export const QUERY_PAGE_DEFAULT = 50 as const;
export const QUERY_PAGE_MAX = 200 as const;

export type MailboxScope = "all" | ReadonlyArray<string>;

// One keyset page position for every list: a timestamp and the row id that breaks its ties.
export type PageCursor = {
  readonly at: string;
  readonly id: string;
};

export type ListMessageSummariesQuery = {
  readonly mailboxScope: MailboxScope;
  readonly direction?: MessageDirection | undefined;
  readonly addressId?: string | undefined;
  readonly since?: string | undefined;
  readonly unread?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: PageCursor | undefined;
};

export type ListThreadSummariesQuery = {
  readonly mailboxScope: MailboxScope;
  readonly limit?: number | undefined;
  readonly cursor?: PageCursor | undefined;
};

export type ListThreadMessageSummariesQuery = {
  readonly mailboxScope: MailboxScope;
  readonly limit?: number | undefined;
  readonly cursor?: PageCursor | undefined;
};

export type AccountAttachmentMeta = {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly contentId: string | null;
  readonly disposition: string | null;
  readonly isInline: boolean;
};

export type StoredParticipants = {
  readonly from: ReadonlyArray<AccountMailContact>;
  readonly replyTo: ReadonlyArray<AccountMailContact>;
  readonly to: ReadonlyArray<AccountMailContact>;
  readonly cc: ReadonlyArray<AccountMailContact>;
};

export type MessageOutboundJob = {
  readonly state: OutboundJobState;
  readonly failureClass: OutboundJobFailureClass | null;
  readonly failureDetail: string | null;
  readonly providerMessageId: string | null;
};

type MessageSummaryFields = StoredParticipants & {
  readonly id: string;
  readonly threadId: string;
  readonly parentMessageId: string | null;
  readonly mailboxId: string;
  readonly subject: string | null;
  readonly occurredAt: string;
  readonly hasRemoteImages: boolean;
  readonly rfcMessageId: NormalizedRfcMessageId | null;
  readonly inReplyToRfcMessageId: NormalizedRfcMessageId | null;
  readonly references: ReadonlyArray<NormalizedRfcMessageId>;
  readonly attachments: ReadonlyArray<AccountAttachmentMeta>;
  readonly isRead: boolean;
  readonly readAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
};

export type InboundMessageSummary = MessageSummaryFields & {
  readonly direction: "inbound";
  readonly envelopeFrom: string;
  readonly envelopeTo: string;
  readonly parsedDate: string | null;
  readonly forwardOutcome: ForwardOutcome;
  readonly forwardDestination: string | null;
};

export type OutboundMessageSummary = MessageSummaryFields & {
  readonly direction: "outbound";
  readonly outboundJob: MessageOutboundJob;
};

export type MessageSummary = InboundMessageSummary | OutboundMessageSummary;

export type MessageSummaryPage = {
  readonly items: ReadonlyArray<MessageSummary>;
  readonly nextCursor: PageCursor | null;
};

export type AccountSendingIdentity = {
  readonly id: string;
  readonly address: MailboxAddress;
  readonly displayName: string | null;
};

export type ThreadSummary = {
  readonly threadId: string;
  readonly subject: string | null;
  readonly latestSender: AccountMailContact | null;
  readonly latestRecipients: ReadonlyArray<AccountMailContact>;
  readonly unreadCount: number;
  readonly messageCount: number;
  readonly involvedMailboxIdentities: ReadonlyArray<AccountSendingIdentity>;
  readonly lastActivityAt: string;
};

export type ThreadSummaryPage = {
  readonly items: ReadonlyArray<ThreadSummary>;
  readonly nextCursor: PageCursor | null;
};

export type ThreadMessageSummaryPage = {
  readonly threadId: string;
  readonly items: ReadonlyArray<MessageSummary>;
  readonly nextCursor: PageCursor | null;
};

export type MessageBody = {
  readonly id: string;
  readonly mailboxId: string;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly hasRemoteImages: boolean;
};

export type StoredAttachment = {
  readonly messageId: string;
  readonly mailboxId: string;
  readonly meta: AccountAttachmentMeta;
  readonly r2Key: string;
};

export type StoredMessageSource =
  | {
      readonly direction: "inbound";
      readonly messageId: string;
      readonly mailboxId: string;
      readonly rawKey: string;
    }
  | {
      readonly direction: "outbound";
      readonly messageId: string;
      readonly mailboxId: string;
    };

export type AccountAddress = {
  readonly id: string;
  readonly localPart: string;
  readonly address: MailboxAddress;
  readonly displayName: string | null;
  readonly active: boolean;
  readonly forwardTo: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PatchAddressInput = {
  readonly displayName?: string | null;
  readonly active?: boolean;
};

export const MessageSummaryRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  mailbox_id: Schema.String,
  direction: MessageDirection,
  subject: Schema.NullOr(Schema.String),
  occurred_at: Schema.String,
  parsed_date: Schema.NullOr(UtcInstant),
  rfc_message_id: Schema.NullOr(NormalizedRfcMessageId),
  in_reply_to_rfc_message_id: Schema.NullOr(NormalizedRfcMessageId),
  parent_message_id: Schema.NullOr(Schema.String),
  has_remote_images: Schema.Finite,
  is_read: Schema.Finite,
  read_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.NullOr(Schema.String),
  receipt_id: Schema.NullOr(Schema.String),
  receipt_envelope_from: Schema.NullOr(Schema.String),
  receipt_envelope_to: Schema.NullOr(Schema.String),
  receipt_forward_outcome: Schema.NullOr(ForwardOutcome),
  receipt_forward_destination: Schema.NullOr(Schema.String),
});
export type MessageSummaryRow = typeof MessageSummaryRow.Type;

export const MessageOutboundJobRow = Schema.Struct({
  message_id: Schema.String,
  state: OutboundJobState,
  failure_class: Schema.NullOr(OutboundJobFailureClass),
  failure_detail: Schema.NullOr(Schema.String),
  provider_message_id: Schema.NullOr(Schema.String),
});

export const ThreadHeadRow = Schema.Struct({
  thread_id: Schema.String,
  latest_message_id: Schema.String,
  last_activity_at: Schema.String,
  subject: Schema.NullOr(Schema.String),
});
export type ThreadHeadRow = typeof ThreadHeadRow.Type;

export const ThreadStatsRow = Schema.Struct({
  thread_id: Schema.String,
  message_count: Schema.Finite,
  unread_count: Schema.Finite,
  involved_mailbox_ids: Schema.NullOr(Schema.String),
});
export type ThreadStatsRow = typeof ThreadStatsRow.Type;

export const ParticipantWithMessageRow = Schema.Struct({
  message_id: Schema.String,
  role: Schema.Literals(["from", "reply_to", "to", "cc"]),
  position: Schema.Finite,
  address: ExternalMailAddress,
  display_name: Schema.NullOr(Schema.String),
});

export const ReferenceWithMessageRow = Schema.Struct({
  message_id: Schema.String,
  position: Schema.Finite,
  rfc_message_id: NormalizedRfcMessageId,
});

export const AttachmentWithMessageRow = Schema.Struct({
  message_id: Schema.String,
  id: Schema.String,
  filename: Schema.String,
  mime_type: Schema.String,
  size: Schema.Finite,
  r2_key: Schema.String,
  content_id: Schema.NullOr(Schema.String),
  disposition: Schema.NullOr(Schema.String),
  is_inline: Schema.Finite,
});

export const MessageBodyRow = Schema.Struct({
  id: Schema.String,
  mailbox_id: Schema.String,
  text_body: Schema.NullOr(Schema.String),
  html_body: Schema.NullOr(Schema.String),
  has_remote_images: Schema.Finite,
  deleted_at: Schema.NullOr(Schema.String),
});

export const StoredAttachmentRow = Schema.Struct({
  message_id: Schema.String,
  mailbox_id: Schema.String,
  deleted_at: Schema.NullOr(Schema.String),
  id: Schema.String,
  filename: Schema.String,
  mime_type: Schema.String,
  size: Schema.Finite,
  r2_key: Schema.String,
  content_id: Schema.NullOr(Schema.String),
  disposition: Schema.NullOr(Schema.String),
  is_inline: Schema.Finite,
});

export const StoredMessageSourceRow = Schema.Struct({
  id: Schema.String,
  mailbox_id: Schema.String,
  direction: MessageDirection,
  deleted_at: Schema.NullOr(Schema.String),
  raw_key: Schema.NullOr(Schema.String),
});

export const AddressRow = Schema.Struct({
  id: Schema.String,
  local_part: Schema.String,
  address: MailboxAddress,
  display_name: Schema.NullOr(Schema.String),
  active: Schema.Finite,
  forward_to: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type AddressRow = typeof AddressRow.Type;

export const MAX_OUTBOUND_RECIPIENTS = 50 as const;

export const OutboundRequesterKind = Schema.Literals(["operator", "mcp"]);

export type OutboundRequester = {
  readonly kind: typeof OutboundRequesterKind.Type;
  readonly clientId: string;
  readonly label: string;
};

export type JobViewer =
  | { readonly kind: "operator" }
  | { readonly kind: "mcp"; readonly clientId: string };

// Sent with every submit and used only when the job needs approval. The link token is an HMAC of
// `approvalId`, so only its hash is stored.
export type ApprovalCapabilityWrite = {
  readonly approvalId: string;
  readonly tokenHash: ApprovalTokenHash;
  readonly expiresAt: string;
};

export type SubmitOutboundInput = {
  readonly requestId: SubmissionRequestId;
  readonly requester: OutboundRequester;
  // The requester's current policy; the store checks the send against it.
  readonly policy: PrincipalPolicy;
  readonly mailboxId: string;
  readonly subject: string;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly hasRemoteImages: boolean;
  readonly to: readonly [AccountMailContact, ...Array<AccountMailContact>];
  readonly cc: ReadonlyArray<AccountMailContact>;
  readonly inReplyToHeader: string | null;
  readonly referencesHeader: string | null;
  readonly nowIso: string;
  readonly approval: ApprovalCapabilityWrite;
};

// Fresh ids for a submit, drawn by the store's RPC layer; the transaction uses them only when it
// creates the job.
export type NewSubmissionIds = {
  readonly messageId: string;
  readonly jobId: string;
  readonly notificationJobId: string;
};

export type OutboundJob = {
  readonly jobId: string;
  readonly requestId: string;
  readonly requester: OutboundRequester;
  readonly messageId: string;
  readonly threadId: string;
  readonly mailboxId: string;
  readonly purpose: OutboundJobPurpose;
  readonly state: OutboundJobState;
  readonly attemptId: string | null;
  readonly providerMessageId: string | null;
  readonly rfcMessageId: string | null;
  readonly failureClass: OutboundJobFailureClass | null;
  readonly failureDetail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type StoredApproval = {
  readonly id: string;
  readonly jobId: string;
  readonly tokenHash: ApprovalTokenHash;
  readonly state: ApprovalState;
  readonly requester: { readonly clientId: string; readonly label: string };
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly expiresAt: string;
};

export type SubmitOutboundResult = {
  readonly job: OutboundJob;
  readonly created: boolean;
  readonly approval: StoredApproval | null;
};

export type ApprovalLookupResult =
  | { readonly kind: "found"; readonly approval: StoredApproval; readonly job: OutboundJob }
  | { readonly kind: "missing" };

export type ApprovalDecisionResult =
  | { readonly kind: "claimed"; readonly state: "approved" | "denied"; readonly job: OutboundJob }
  | {
      readonly kind: "resolved";
      readonly state: "approved" | "denied" | "expired" | "cancelled";
      readonly job: OutboundJob | null;
      readonly expiresAt: string;
    }
  | { readonly kind: "unavailable"; readonly state: "pending" }
  | { readonly kind: "missing" };

export type ClaimJobInput = {
  readonly jobId: string;
  readonly attemptId: string;
  readonly nowIso: string;
  readonly claimExpiresAt: string;
  // The requester's policy at claim time; null when the requester no longer has access.
  readonly policy: PrincipalPolicy | null;
};

export type ClaimJobResult =
  | { readonly kind: "claimed"; readonly attemptId: string; readonly job: OutboundJob }
  | { readonly kind: "not_claimable"; readonly job: OutboundJob }
  | { readonly kind: "rejected"; readonly job: OutboundJob }
  | { readonly kind: "missing" };

export type CompleteAttemptOutcome =
  | {
      readonly kind: "accepted";
      readonly providerMessageId: string;
      readonly rfcMessageId: NormalizedRfcMessageId | null;
    }
  | { readonly kind: "rejected"; readonly failureDetail: string }
  | { readonly kind: "unknown" };

export type CompleteAttemptInput = {
  readonly jobId: string;
  readonly attemptId: string;
  readonly nowIso: string;
  readonly outcome: CompleteAttemptOutcome;
};

export type CompleteAttemptResult =
  | { readonly kind: "applied"; readonly job: OutboundJob }
  | { readonly kind: "stale"; readonly job: OutboundJob }
  | { readonly kind: "missing" };

export type OutboundDispatch = {
  readonly job: OutboundJob;
  readonly subject: string;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly hasRemoteImages: boolean;
  readonly from: AccountMailContact | null;
  readonly replyTo: AccountMailContact | null;
  readonly to: ReadonlyArray<AccountMailContact>;
  readonly cc: ReadonlyArray<AccountMailContact>;
  readonly inReplyToHeader: string | null;
  readonly referencesHeader: string | null;
  // Set for an approval_notification job whose approval is still pending.
  readonly approval: { readonly approvalId: string; readonly expiresAt: string } | null;
};

export type ListOutboundJobsQuery = {
  readonly viewer: JobViewer;
  readonly limit?: number | undefined;
  readonly cursor?: PageCursor | undefined;
};

export type OutboundJobPage = {
  readonly items: ReadonlyArray<OutboundJob>;
  readonly nextCursor: PageCursor | null;
};

export type DecideApprovalInput = {
  readonly tokenHash: ApprovalTokenHash;
  readonly decision: "approved" | "denied";
  readonly nowIso: string;
};

export const OutboundJobRow = Schema.Struct({
  id: Schema.String,
  requester_kind: OutboundRequesterKind,
  requester_client_id: Schema.String,
  requester_label: Schema.String,
  idempotency_key: Schema.String,
  intent_fingerprint: Schema.String,
  message_id: Schema.String,
  mailbox_id: Schema.String,
  purpose: OutboundJobPurpose,
  state: OutboundJobState,
  attempt_id: Schema.NullOr(Schema.String),
  attempt_claimed_at: Schema.NullOr(Schema.String),
  claim_expires_at: Schema.NullOr(Schema.String),
  provider_message_id: Schema.NullOr(Schema.String),
  rfc_message_id: Schema.NullOr(Schema.String),
  failure_class: Schema.NullOr(OutboundJobFailureClass),
  failure_detail: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  thread_id: Schema.String,
});
export type OutboundJobRow = typeof OutboundJobRow.Type;

export const ApprovalRequestRow = Schema.Struct({
  id: Schema.String,
  job_id: Schema.String,
  token_hash: ApprovalTokenHash,
  state: ApprovalState,
  requester_client_id: Schema.String,
  requester_label: Schema.String,
  created_at: Schema.String,
  resolved_at: Schema.NullOr(Schema.String),
  expires_at: Schema.String,
});
export type ApprovalRequestRow = typeof ApprovalRequestRow.Type;
