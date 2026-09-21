import {
  ApprovalState,
  ApprovalTokenHash,
  ExternalMailAddress,
  MailDomain,
  NormalizedRfcMessageId,
  OutboundJobFailureClass,
  OutboundJobPurpose,
  OutboundJobState,
  PrincipalMailboxIds,
  PrincipalPolicy,
  PrincipalRecipientAllowlist,
  SubmissionRequestId,
  UtcInstant,
} from "@umail/api-contract";
import * as Schema from "effect/Schema";

export const SchemaStatus = Schema.Struct({
  schemaVersion: Schema.Finite,
  accountId: Schema.String,
});
export type SchemaStatus = typeof SchemaStatus.Type;

export const CommandItem = Schema.Struct({
  id: Schema.String,
  groupId: Schema.String,
  label: Schema.String,
});
export type CommandItem = typeof CommandItem.Type;

export const CommandItemInput = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});
export type CommandItemInput = typeof CommandItemInput.Type;

export const RecordItemGroupInput = Schema.Struct({
  groupId: Schema.String,
  items: Schema.Array(CommandItemInput),
});
export type RecordItemGroupInput = typeof RecordItemGroupInput.Type;

export const ItemIdList = Schema.Array(Schema.String);
export type ItemIdList = typeof ItemIdList.Type;

export const CommandItemRow = Schema.Struct({
  id: Schema.String,
  group_id: Schema.String,
  label: Schema.String,
});
export type CommandItemRow = typeof CommandItemRow.Type;

export const SchemaMigrationRow = Schema.Struct({
  version: Schema.Finite,
  name: Schema.String,
});
export type SchemaMigrationRow = typeof SchemaMigrationRow.Type;

export const AccountMetaRow = Schema.Struct({
  account_id: Schema.String,
});
export type AccountMetaRow = typeof AccountMetaRow.Type;

export const CatalogNameRow = Schema.Struct({
  name: Schema.String,
});
export type CatalogNameRow = typeof CatalogNameRow.Type;

export const MessageDirection = Schema.Literals(["inbound", "outbound"]);
export type MessageDirection = typeof MessageDirection.Type;

export const ThreadingDiagnosticKind = Schema.Literals([
  "parent_cycle",
  "parent_replacement",
  "threading_limited",
]);
export type ThreadingDiagnosticKind = typeof ThreadingDiagnosticKind.Type;

export const ThreadingDiagnostic = Schema.Struct({
  id: Schema.String,
  messageId: Schema.String,
  nodeId: Schema.String,
  kind: ThreadingDiagnosticKind,
  detail: Schema.String,
  createdAt: Schema.String,
});
export type ThreadingDiagnostic = typeof ThreadingDiagnostic.Type;

export const MessageAttachmentWrite = Schema.Struct({
  id: Schema.String,
  position: Schema.Finite,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Finite,
  r2Key: Schema.String,
  contentId: Schema.NullOr(Schema.String),
  disposition: Schema.NullOr(Schema.String),
  isInline: Schema.Boolean,
});
export type MessageAttachmentWrite = typeof MessageAttachmentWrite.Type;

export const AccountMailContact = Schema.Struct({
  address: ExternalMailAddress,
  displayName: Schema.NullOr(Schema.String),
});
export type AccountMailContact = typeof AccountMailContact.Type;

const acceptMessageFields = {
  messageId: Schema.String,
  mailboxId: Schema.String,
  rfcMessageId: Schema.NullOr(Schema.String),
  inReplyToHeader: Schema.NullOr(Schema.String),
  referencesHeader: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
  nowIso: Schema.String,
  subject: Schema.optionalKey(Schema.NullOr(Schema.String)),
  textBody: Schema.optionalKey(Schema.NullOr(Schema.String)),
  htmlBody: Schema.optionalKey(Schema.NullOr(Schema.String)),
  hasRemoteImages: Schema.optionalKey(Schema.Boolean),
  from: Schema.optionalKey(Schema.Array(AccountMailContact)),
  replyTo: Schema.optionalKey(Schema.Array(AccountMailContact)),
  to: Schema.optionalKey(Schema.Array(AccountMailContact)),
  cc: Schema.optionalKey(Schema.Array(AccountMailContact)),
  attachments: Schema.optionalKey(Schema.Array(MessageAttachmentWrite)),
};

export const AcceptInboundInput = Schema.Struct({
  ...acceptMessageFields,
  parsedDate: Schema.NullOr(UtcInstant),
});
export type AcceptInboundInput = typeof AcceptInboundInput.Type;

export const AcceptOutboundInput = Schema.Struct(acceptMessageFields);
export type AcceptOutboundInput = typeof AcceptOutboundInput.Type;

export const AcceptMessageResult = Schema.Struct({
  messageId: Schema.String,
  nodeId: Schema.String,
  threadHandle: Schema.String,
  componentRootId: Schema.String,
  claimedRfcMessageId: Schema.NullOr(Schema.String),
  parentNodeId: Schema.NullOr(Schema.String),
  diagnostics: Schema.Array(ThreadingDiagnostic),
});
export type AcceptMessageResult = typeof AcceptMessageResult.Type;

export const ConversationMessage = Schema.Struct({
  id: Schema.String,
  nodeId: Schema.String,
  mailboxId: Schema.String,
  direction: MessageDirection,
  rfcMessageId: Schema.NullOr(Schema.String),
  parentNodeId: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});
export type ConversationMessage = typeof ConversationMessage.Type;

export const ConversationView = Schema.Struct({
  handle: Schema.String,
  nodeId: Schema.String,
  componentRootId: Schema.String,
  messages: Schema.Array(ConversationMessage),
  diagnostics: Schema.Array(ThreadingDiagnostic),
});
export type ConversationView = typeof ConversationView.Type;

export const RfcLookupView = Schema.Struct({
  rfcMessageId: Schema.String,
  nodeId: Schema.String,
  claimantNodeId: Schema.NullOr(Schema.String),
});
export type RfcLookupView = typeof RfcLookupView.Type;

export const ThreadNodeKind = Schema.Literals(["placeholder", "message"]);
export type ThreadNodeKind = typeof ThreadNodeKind.Type;

export const ThreadNodeRow = Schema.Struct({
  id: Schema.String,
  kind: ThreadNodeKind,
});
export type ThreadNodeRow = typeof ThreadNodeRow.Type;

export const RfcLookupRow = Schema.Struct({
  rfc_message_id: Schema.String,
  node_id: Schema.String,
  claimant_node_id: Schema.NullOr(Schema.String),
});
export type RfcLookupRow = typeof RfcLookupRow.Type;

export const ComponentLinkRow = Schema.Struct({
  node_id: Schema.String,
  parent_node_id: Schema.String,
  rank: Schema.Finite,
  size: Schema.Finite,
});
export type ComponentLinkRow = typeof ComponentLinkRow.Type;

export const ParentEdgeRow = Schema.Struct({
  parent_node_id: Schema.String,
});
export type ParentEdgeRow = typeof ParentEdgeRow.Type;

export const MessageIdPresenceRow = Schema.Struct({
  id: Schema.String,
});
export type MessageIdPresenceRow = typeof MessageIdPresenceRow.Type;

export const ConversationMessageRow = Schema.Struct({
  id: Schema.String,
  node_id: Schema.String,
  mailbox_id: Schema.String,
  direction: MessageDirection,
  rfc_message_id: Schema.NullOr(Schema.String),
  parent_node_id: Schema.NullOr(Schema.String),
  occurred_at: Schema.String,
  deleted_at: Schema.NullOr(Schema.String),
});
export type ConversationMessageRow = typeof ConversationMessageRow.Type;

export const ThreadingDiagnosticRow = Schema.Struct({
  id: Schema.String,
  message_id: Schema.String,
  node_id: Schema.String,
  kind: ThreadingDiagnosticKind,
  detail: Schema.String,
  created_at: Schema.String,
});
export type ThreadingDiagnosticRow = typeof ThreadingDiagnosticRow.Type;

export const ReceiptForwardNone = Schema.Struct({
  kind: Schema.Literal("none"),
});
export type ReceiptForwardNone = typeof ReceiptForwardNone.Type;

export const ReceiptForwardSuccess = Schema.Struct({
  kind: Schema.Literal("success"),
  destination: Schema.String,
});
export type ReceiptForwardSuccess = typeof ReceiptForwardSuccess.Type;

export const ReceiptForwardFailure = Schema.Struct({
  kind: Schema.Literal("failure"),
  destination: Schema.String,
  error: Schema.String,
});
export type ReceiptForwardFailure = typeof ReceiptForwardFailure.Type;

export const ReceiptForwardUnknown = Schema.Struct({
  kind: Schema.Literal("unknown"),
  destination: Schema.String,
});
export type ReceiptForwardUnknown = typeof ReceiptForwardUnknown.Type;

export const ReceiptForwardObservation = Schema.Union([
  ReceiptForwardNone,
  ReceiptForwardSuccess,
  ReceiptForwardFailure,
  ReceiptForwardUnknown,
]);
export type ReceiptForwardObservation = typeof ReceiptForwardObservation.Type;

export const InboundForwardAttempt = Schema.Union([
  ReceiptForwardUnknown,
  ReceiptForwardSuccess,
  ReceiptForwardFailure,
]);
export type InboundForwardAttempt = typeof InboundForwardAttempt.Type;

export const ReceiptWorkState = Schema.Literals([
  "ready",
  "claimed",
  "indexed",
  "policy_failed",
  "terminal",
  "operator_reprocess",
]);
export type ReceiptWorkState = typeof ReceiptWorkState.Type;

export const ReceiptPolicyError = Schema.Literals([
  "attachment_cap",
  "message_budget",
  "mime_budget",
  "parse_failed",
  "rfc822_depth",
  "sanitize_failed",
]);
export type ReceiptPolicyError = typeof ReceiptPolicyError.Type;

export const InboundReceipt = Schema.Struct({
  receiptId: Schema.String,
  digest: Schema.String,
  envelopeFrom: Schema.String,
  envelopeTo: Schema.String,
  rawKey: Schema.String,
  manifestKey: Schema.String,
  advertisedRawSize: Schema.Finite,
  consumedBytes: Schema.Finite,
  receivedAt: Schema.String,
  createdAt: Schema.String,
  forward: ReceiptForwardObservation,
  workState: ReceiptWorkState,
  policyError: Schema.NullOr(ReceiptPolicyError),
  claimedUntil: Schema.NullOr(Schema.String),
  retryAfter: Schema.NullOr(Schema.String),
  attemptCount: Schema.Finite,
  lastError: Schema.NullOr(Schema.String),
});
export type InboundReceipt = typeof InboundReceipt.Type;

export const RegisterInboundReceiptInput = Schema.Struct({
  receiptId: Schema.String,
  digest: Schema.String,
  envelopeFrom: Schema.String,
  envelopeTo: Schema.String,
  rawKey: Schema.String,
  manifestKey: Schema.String,
  advertisedRawSize: Schema.Finite,
  consumedBytes: Schema.Finite,
  receivedAt: Schema.String,
});
export type RegisterInboundReceiptInput = typeof RegisterInboundReceiptInput.Type;

export const RegisterInboundReceiptResult = Schema.Struct({
  receipt: InboundReceipt,
  created: Schema.Boolean,
});
export type RegisterInboundReceiptResult = typeof RegisterInboundReceiptResult.Type;

export const ObserveInboundForwardInput = Schema.Struct({
  receiptId: Schema.String,
  observation: InboundForwardAttempt,
});
export type ObserveInboundForwardInput = typeof ObserveInboundForwardInput.Type;

export const FailInboundReceiptPolicyInput = Schema.Struct({
  receiptId: Schema.String,
  reason: ReceiptPolicyError,
});
export type FailInboundReceiptPolicyInput = typeof FailInboundReceiptPolicyInput.Type;

export const ClaimInboundReceiptInput = Schema.Struct({
  receiptId: Schema.String,
  nowIso: Schema.String,
  claimUntilIso: Schema.String,
});
export type ClaimInboundReceiptInput = typeof ClaimInboundReceiptInput.Type;

export const ClaimInboundReceiptResult = Schema.Struct({
  receipt: InboundReceipt,
  claimed: Schema.Boolean,
});
export type ClaimInboundReceiptResult = typeof ClaimInboundReceiptResult.Type;

export const RecordInboundReceiptRedriveInput = Schema.Struct({
  receiptId: Schema.String,
  nowIso: Schema.String,
  retryAfterIso: Schema.String,
  attemptBudget: Schema.Finite,
});
export type RecordInboundReceiptRedriveInput = typeof RecordInboundReceiptRedriveInput.Type;

export const InboundReceiptWorkKind = Schema.Literals(["ready", "expired_claim"]);
export type InboundReceiptWorkKind = typeof InboundReceiptWorkKind.Type;

export const ListInboundReceiptWorkInput = Schema.Struct({
  kind: InboundReceiptWorkKind,
  nowIso: Schema.String,
  limit: Schema.optionalKey(Schema.Finite),
});
export type ListInboundReceiptWorkInput = typeof ListInboundReceiptWorkInput.Type;

export const InboundReceiptWorkCursor = Schema.Struct({
  receivedAt: Schema.String,
  id: Schema.String,
});
export type InboundReceiptWorkCursor = typeof InboundReceiptWorkCursor.Type;

export const ListInboundReceiptWorkPage = Schema.Struct({
  items: Schema.Array(InboundReceipt),
  nextCursor: Schema.NullOr(InboundReceiptWorkCursor),
});
export type ListInboundReceiptWorkPage = typeof ListInboundReceiptWorkPage.Type;

export const RecoveryScan = Schema.Struct({
  scanId: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type RecoveryScan = typeof RecoveryScan.Type;

export const PutRecoveryScanInput = Schema.Struct({
  scanId: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type PutRecoveryScanInput = typeof PutRecoveryScanInput.Type;

export const InboundReceiptRow = Schema.Struct({
  id: Schema.String,
  digest: Schema.String,
  envelope_from: Schema.String,
  envelope_to: Schema.String,
  raw_key: Schema.String,
  manifest_key: Schema.String,
  advertised_raw_size: Schema.Finite,
  consumed_bytes: Schema.Finite,
  received_at: Schema.String,
  created_at: Schema.String,
  forward_outcome: Schema.Literals(["none", "success", "failure", "unknown"]),
  forward_destination: Schema.NullOr(Schema.String),
  forward_error: Schema.NullOr(Schema.String),
  work_state: ReceiptWorkState,
  policy_error: Schema.NullOr(ReceiptPolicyError),
  claimed_until: Schema.NullOr(Schema.String),
  retry_after: Schema.NullOr(Schema.String),
  attempt_count: Schema.Finite,
  last_error: Schema.NullOr(Schema.String),
});
export type InboundReceiptRow = typeof InboundReceiptRow.Type;

export const RecoveryScanRow = Schema.Struct({
  id: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
});
export type RecoveryScanRow = typeof RecoveryScanRow.Type;

export const QUERY_PAGE_DEFAULT = 50 as const;
export const QUERY_PAGE_MAX = 200 as const;

export const MailboxScope = Schema.Union([Schema.Literal("all"), Schema.Array(Schema.String)]);
export type MailboxScope = typeof MailboxScope.Type;

export const MessageListCursor = Schema.Struct({
  occurredAt: UtcInstant,
  id: Schema.String,
});
export type MessageListCursor = typeof MessageListCursor.Type;

export const ThreadListCursor = Schema.Struct({
  lastActivityAt: UtcInstant,
  threadHandle: Schema.String,
});
export type ThreadListCursor = typeof ThreadListCursor.Type;

export const ListMessageSummariesQuery = Schema.Struct({
  mailboxScope: MailboxScope,
  direction: Schema.optionalKey(MessageDirection),
  addressId: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(UtcInstant),
  unread: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(MessageListCursor),
});
export type ListMessageSummariesQuery = typeof ListMessageSummariesQuery.Type;

export const ListThreadSummariesQuery = Schema.Struct({
  mailboxScope: MailboxScope,
  mailDomain: MailDomain,
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(ThreadListCursor),
});
export type ListThreadSummariesQuery = typeof ListThreadSummariesQuery.Type;

export const ListThreadMessageSummariesQuery = Schema.Struct({
  mailboxScope: MailboxScope,
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(MessageListCursor),
});
export type ListThreadMessageSummariesQuery = typeof ListThreadMessageSummariesQuery.Type;

export const AccountAttachmentMeta = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Finite,
  contentId: Schema.NullOr(Schema.String),
  disposition: Schema.NullOr(Schema.String),
  isInline: Schema.Boolean,
});
export type AccountAttachmentMeta = typeof AccountAttachmentMeta.Type;

export const StoredParticipants = Schema.Struct({
  from: Schema.Array(AccountMailContact),
  replyTo: Schema.Array(AccountMailContact),
  to: Schema.Array(AccountMailContact),
  cc: Schema.Array(AccountMailContact),
});
export type StoredParticipants = typeof StoredParticipants.Type;

export const MessageOutboundJob = Schema.Struct({
  state: OutboundJobState,
  failureClass: Schema.NullOr(OutboundJobFailureClass),
  failureDetail: Schema.NullOr(Schema.String),
  providerMessageId: Schema.NullOr(Schema.String),
});
export type MessageOutboundJob = typeof MessageOutboundJob.Type;

const messageSummaryFields = {
  id: Schema.String,
  threadHandle: Schema.String,
  parentMessageId: Schema.NullOr(Schema.String),
  mailboxId: Schema.String,
  subject: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
  from: Schema.Array(AccountMailContact),
  replyTo: Schema.Array(AccountMailContact),
  to: Schema.Array(AccountMailContact),
  cc: Schema.Array(AccountMailContact),
  hasRemoteImages: Schema.Boolean,
  rfcMessageId: Schema.NullOr(Schema.String),
  inReplyToRfcMessageId: Schema.NullOr(Schema.String),
  references: Schema.Array(Schema.String),
  attachments: Schema.Array(AccountAttachmentMeta),
  isRead: Schema.Boolean,
  readAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
};

export const InboundMessageSummary = Schema.Struct({
  direction: Schema.Literal("inbound"),
  ...messageSummaryFields,
  envelopeFrom: Schema.String,
  envelopeTo: Schema.String,
  parsedDate: Schema.NullOr(UtcInstant),
  forward: ReceiptForwardObservation,
});
export type InboundMessageSummary = typeof InboundMessageSummary.Type;

export const OutboundMessageSummary = Schema.Struct({
  direction: Schema.Literal("outbound"),
  ...messageSummaryFields,
  outboundJob: MessageOutboundJob,
});
export type OutboundMessageSummary = typeof OutboundMessageSummary.Type;

export const MessageSummary = Schema.Union([InboundMessageSummary, OutboundMessageSummary]);
export type MessageSummary = typeof MessageSummary.Type;

export const MessageSummaryPage = Schema.Struct({
  items: Schema.Array(MessageSummary),
  nextCursor: Schema.NullOr(MessageListCursor),
});
export type MessageSummaryPage = typeof MessageSummaryPage.Type;

export const AccountSendingIdentity = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  displayName: Schema.NullOr(Schema.String),
});
export type AccountSendingIdentity = typeof AccountSendingIdentity.Type;

export const ThreadSummary = Schema.Struct({
  threadHandle: Schema.String,
  subject: Schema.NullOr(Schema.String),
  latestSender: Schema.NullOr(AccountMailContact),
  latestRecipients: Schema.Array(AccountMailContact),
  unreadCount: Schema.Finite,
  messageCount: Schema.Finite,
  involvedMailboxIdentities: Schema.Array(AccountSendingIdentity),
  lastActivityAt: Schema.String,
});
export type ThreadSummary = typeof ThreadSummary.Type;

export const ThreadSummaryPage = Schema.Struct({
  items: Schema.Array(ThreadSummary),
  nextCursor: Schema.NullOr(ThreadListCursor),
});
export type ThreadSummaryPage = typeof ThreadSummaryPage.Type;

export const ThreadMessageSummaryPage = Schema.Struct({
  threadHandle: Schema.String,
  items: Schema.Array(MessageSummary),
  nextCursor: Schema.NullOr(MessageListCursor),
});
export type ThreadMessageSummaryPage = typeof ThreadMessageSummaryPage.Type;

export const MessageBody = Schema.Struct({
  id: Schema.String,
  mailboxId: Schema.String,
  textBody: Schema.NullOr(Schema.String),
  htmlBody: Schema.NullOr(Schema.String),
  hasRemoteImages: Schema.Boolean,
});
export type MessageBody = typeof MessageBody.Type;

export const StoredAttachment = Schema.Struct({
  messageId: Schema.String,
  mailboxId: Schema.String,
  meta: AccountAttachmentMeta,
  r2Key: Schema.String,
});
export type StoredAttachment = typeof StoredAttachment.Type;

export const InboundStoredMessageSource = Schema.Struct({
  direction: Schema.Literal("inbound"),
  messageId: Schema.String,
  mailboxId: Schema.String,
  rawKey: Schema.String,
});
export type InboundStoredMessageSource = typeof InboundStoredMessageSource.Type;

export const OutboundStoredMessageSource = Schema.Struct({
  direction: Schema.Literal("outbound"),
  messageId: Schema.String,
  mailboxId: Schema.String,
});
export type OutboundStoredMessageSource = typeof OutboundStoredMessageSource.Type;

export const StoredMessageSource = Schema.Union([
  InboundStoredMessageSource,
  OutboundStoredMessageSource,
]);
export type StoredMessageSource = typeof StoredMessageSource.Type;

export const AccountAddress = Schema.Struct({
  id: Schema.String,
  localPart: Schema.String,
  address: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  forwardingDestinationId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type AccountAddress = typeof AccountAddress.Type;

export const PatchAddressInput = Schema.Struct({
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  active: Schema.optionalKey(Schema.Boolean),
});
export type PatchAddressInput = typeof PatchAddressInput.Type;

export const AccountDestination = Schema.Struct({
  id: Schema.String,
  cloudflareId: Schema.String,
  email: Schema.String,
  verificationStatus: Schema.Literals(["pending", "verified"]),
  verifiedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type AccountDestination = typeof AccountDestination.Type;

export const McpOAuthPolicyState = Schema.Literals(["active", "disabled", "revoked"]);
export type McpOAuthPolicyState = typeof McpOAuthPolicyState.Type;

export const McpOAuthPolicy = Schema.Struct({
  clientId: Schema.String,
  label: Schema.String,
  state: McpOAuthPolicyState,
  policy: PrincipalPolicy,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type McpOAuthPolicy = typeof McpOAuthPolicy.Type;

export const EnsureMcpOAuthPolicyInput = Schema.Struct({
  clientId: Schema.String,
  label: Schema.String,
  createdAt: Schema.String,
});
export type EnsureMcpOAuthPolicyInput = typeof EnsureMcpOAuthPolicyInput.Type;

export const UpdateMcpOAuthPolicyInput = Schema.Struct({
  clientId: Schema.String,
  label: Schema.String,
  policy: PrincipalPolicy,
  updatedAt: Schema.String,
});
export type UpdateMcpOAuthPolicyInput = typeof UpdateMcpOAuthPolicyInput.Type;

export const SetMcpOAuthPolicyStateInput = Schema.Struct({
  clientId: Schema.String,
  state: Schema.Literals(["active", "disabled"]),
  updatedAt: Schema.String,
});
export type SetMcpOAuthPolicyStateInput = typeof SetMcpOAuthPolicyStateInput.Type;

export const MessageSummaryRow = Schema.Struct({
  id: Schema.String,
  node_id: Schema.String,
  mailbox_id: Schema.String,
  direction: MessageDirection,
  subject: Schema.NullOr(Schema.String),
  occurred_at: Schema.String,
  parsed_date: Schema.NullOr(UtcInstant),
  rfc_message_id: Schema.NullOr(Schema.String),
  in_reply_to_rfc_message_id: Schema.NullOr(Schema.String),
  parent_message_id: Schema.NullOr(Schema.String),
  has_remote_images: Schema.Finite,
  is_read: Schema.Finite,
  read_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.NullOr(Schema.String),
  receipt_id: Schema.NullOr(Schema.String),
  receipt_envelope_from: Schema.NullOr(Schema.String),
  receipt_envelope_to: Schema.NullOr(Schema.String),
  receipt_forward_outcome: Schema.NullOr(
    Schema.Literals(["none", "success", "failure", "unknown"]),
  ),
  receipt_forward_destination: Schema.NullOr(Schema.String),
  receipt_forward_error: Schema.NullOr(Schema.String),
});
export type MessageSummaryRow = typeof MessageSummaryRow.Type;

export const MessageOutboundJobRow = Schema.Struct({
  message_id: Schema.String,
  state: OutboundJobState,
  failure_class: Schema.NullOr(OutboundJobFailureClass),
  failure_detail: Schema.NullOr(Schema.String),
  provider_message_id: Schema.NullOr(Schema.String),
});
export type MessageOutboundJobRow = typeof MessageOutboundJobRow.Type;

export const ThreadActivityRow = Schema.Struct({
  root_id: Schema.String,
  last_activity_at: Schema.String,
  message_count: Schema.Finite,
  unread_count: Schema.Finite,
  involved_mailbox_ids: Schema.NullOr(Schema.String),
});
export type ThreadActivityRow = typeof ThreadActivityRow.Type;

export const LatestThreadMessageRow = Schema.Struct({
  root_id: Schema.String,
  id: Schema.String,
  subject: Schema.NullOr(Schema.String),
});
export type LatestThreadMessageRow = typeof LatestThreadMessageRow.Type;

export const ParticipantWithMessageRow = Schema.Struct({
  message_id: Schema.String,
  role: Schema.Literals(["from", "reply_to", "to", "cc"]),
  position: Schema.Finite,
  address: Schema.String,
  display_name: Schema.NullOr(Schema.String),
});
export type ParticipantWithMessageRow = typeof ParticipantWithMessageRow.Type;

export const ReferenceWithMessageRow = Schema.Struct({
  message_id: Schema.String,
  position: Schema.Finite,
  rfc_message_id: Schema.String,
});
export type ReferenceWithMessageRow = typeof ReferenceWithMessageRow.Type;

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
export type AttachmentWithMessageRow = typeof AttachmentWithMessageRow.Type;

export const MessageBodyRow = Schema.Struct({
  id: Schema.String,
  mailbox_id: Schema.String,
  text_body: Schema.NullOr(Schema.String),
  html_body: Schema.NullOr(Schema.String),
  has_remote_images: Schema.Finite,
  deleted_at: Schema.NullOr(Schema.String),
});
export type MessageBodyRow = typeof MessageBodyRow.Type;

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
export type StoredAttachmentRow = typeof StoredAttachmentRow.Type;

export const StoredMessageSourceRow = Schema.Struct({
  id: Schema.String,
  mailbox_id: Schema.String,
  direction: MessageDirection,
  deleted_at: Schema.NullOr(Schema.String),
  raw_key: Schema.NullOr(Schema.String),
});
export type StoredMessageSourceRow = typeof StoredMessageSourceRow.Type;

export const AddressRow = Schema.Struct({
  id: Schema.String,
  local_part: Schema.String,
  address: Schema.String,
  display_name: Schema.NullOr(Schema.String),
  active: Schema.Finite,
  forwarding_destination_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type AddressRow = typeof AddressRow.Type;

export const DestinationRow = Schema.Struct({
  id: Schema.String,
  cloudflare_id: Schema.String,
  email: Schema.String,
  verification_status: Schema.Literals(["pending", "verified"]),
  verified_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type DestinationRow = typeof DestinationRow.Type;

export const McpOAuthPolicyRow = Schema.Struct({
  client_id: Schema.String,
  label: Schema.String,
  state: McpOAuthPolicyState,
  mailbox_ids_json: Schema.String,
  can_read: Schema.Literals([0, 1]),
  can_delete: Schema.Literals([0, 1]),
  send_mode: Schema.Literals(["deny", "allow", "requireApproval"]),
  recipient_allowlist_json: Schema.String,
  preapproved_recipients_json: Schema.String,
  can_admin: Schema.Literals([0, 1]),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type McpOAuthPolicyRow = typeof McpOAuthPolicyRow.Type;

export const StoredMailboxIds = Schema.fromJsonString(PrincipalMailboxIds);
export const StoredRecipientAllowlist = Schema.fromJsonString(PrincipalRecipientAllowlist);
export const StoredPreapprovedRecipients = Schema.fromJsonString(Schema.Array(ExternalMailAddress));

export const MAX_OUTBOUND_RECIPIENTS = 50 as const;

export const OutboundRequesterKind = Schema.Literals(["operator", "mcp"]);
export type OutboundRequesterKind = typeof OutboundRequesterKind.Type;

export const OutboundRequester = Schema.Struct({
  kind: OutboundRequesterKind,
  clientId: Schema.String.check(Schema.isMinLength(1)),
  label: Schema.String.check(Schema.isMinLength(1)),
});
export type OutboundRequester = typeof OutboundRequester.Type;

export const JobViewer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("operator"),
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    clientId: Schema.String.check(Schema.isMinLength(1)),
  }),
]);
export type JobViewer = typeof JobViewer.Type;

export const ApprovalNotificationWrite = Schema.Struct({
  keyVersion: Schema.String.check(Schema.isMinLength(1)),
  nonce: Schema.String.check(Schema.isMinLength(1)),
  ciphertext: Schema.String.check(Schema.isMinLength(1)),
});
export type ApprovalNotificationWrite = typeof ApprovalNotificationWrite.Type;

export const ApprovalCapabilityWrite = Schema.Struct({
  tokenHash: ApprovalTokenHash,
  expiresAt: Schema.String,
  notification: ApprovalNotificationWrite,
});
export type ApprovalCapabilityWrite = typeof ApprovalCapabilityWrite.Type;

export const SubmitOutboundInput = Schema.Struct({
  requestId: SubmissionRequestId,
  requester: OutboundRequester,
  mailboxId: Schema.String,
  mailDomain: MailDomain,
  subject: Schema.String,
  textBody: Schema.NullOr(Schema.String),
  htmlBody: Schema.NullOr(Schema.String),
  hasRemoteImages: Schema.Boolean,
  to: Schema.NonEmptyArray(AccountMailContact),
  cc: Schema.Array(AccountMailContact),
  inReplyToHeader: Schema.NullOr(Schema.String),
  referencesHeader: Schema.NullOr(Schema.String),
  nowIso: Schema.String,
  approval: Schema.optionalKey(ApprovalCapabilityWrite),
});
export type SubmitOutboundInput = typeof SubmitOutboundInput.Type;

export const OutboundJob = Schema.Struct({
  jobId: Schema.String,
  requestId: Schema.String.check(Schema.isMinLength(1)),
  requester: OutboundRequester,
  messageId: Schema.String,
  threadHandle: Schema.String,
  mailboxId: Schema.String,
  purpose: OutboundJobPurpose,
  state: OutboundJobState,
  attemptId: Schema.NullOr(Schema.String),
  providerMessageId: Schema.NullOr(Schema.String),
  rfcMessageId: Schema.NullOr(Schema.String),
  failureClass: Schema.NullOr(OutboundJobFailureClass),
  failureDetail: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type OutboundJob = typeof OutboundJob.Type;

export const ApprovalRequesterView = Schema.Struct({
  clientId: Schema.String.check(Schema.isMinLength(1)),
  label: Schema.String.check(Schema.isMinLength(1)),
});
export type ApprovalRequesterView = typeof ApprovalRequesterView.Type;

export const StoredApproval = Schema.Struct({
  id: Schema.String,
  jobId: Schema.String,
  tokenHash: ApprovalTokenHash,
  state: ApprovalState,
  requester: ApprovalRequesterView,
  createdAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.String,
});
export type StoredApproval = typeof StoredApproval.Type;

export const SubmitOutboundResult = Schema.Struct({
  job: OutboundJob,
  created: Schema.Boolean,
  approval: Schema.NullOr(StoredApproval),
});
export type SubmitOutboundResult = typeof SubmitOutboundResult.Type;

export const ApprovalLookupResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("found"),
    approval: StoredApproval,
    job: OutboundJob,
  }),
  Schema.Struct({
    kind: Schema.Literal("missing"),
  }),
]);
export type ApprovalLookupResult = typeof ApprovalLookupResult.Type;

export const ApprovalDecision = Schema.Literals(["approved", "denied"]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

export const ApprovalDecisionResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("claimed"),
    state: ApprovalDecision,
    job: OutboundJob,
  }),
  Schema.Struct({
    kind: Schema.Literal("resolved"),
    state: Schema.Literals(["approved", "denied", "expired", "cancelled"]),
    job: Schema.NullOr(OutboundJob),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    state: Schema.Literal("pending"),
  }),
  Schema.Struct({
    kind: Schema.Literal("missing"),
  }),
]);
export type ApprovalDecisionResult = typeof ApprovalDecisionResult.Type;

export const ApprovalConvergenceResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("transitioned"),
    state: Schema.Literals(["expired", "cancelled"]),
    job: OutboundJob,
  }),
  Schema.Struct({
    kind: Schema.Literal("resolved"),
    state: Schema.Literals(["approved", "denied", "expired", "cancelled"]),
    job: Schema.NullOr(OutboundJob),
  }),
  Schema.Struct({
    kind: Schema.Literal("pending"),
  }),
  Schema.Struct({
    kind: Schema.Literal("missing"),
  }),
]);
export type ApprovalConvergenceResult = typeof ApprovalConvergenceResult.Type;

export const ClaimDispatchInput = Schema.Struct({
  jobId: Schema.String,
  nowIso: Schema.String,
  claimExpiresAt: Schema.String,
});
export type ClaimDispatchInput = typeof ClaimDispatchInput.Type;

export const ClaimDispatchResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("claimed"),
    attemptId: Schema.String,
    job: OutboundJob,
  }),
  Schema.Struct({
    kind: Schema.Literal("not_claimable"),
    job: OutboundJob,
  }),
  Schema.Struct({
    kind: Schema.Literal("rejected"),
    job: OutboundJob,
  }),
  Schema.Struct({
    kind: Schema.Literal("missing"),
  }),
]);
export type ClaimDispatchResult = typeof ClaimDispatchResult.Type;

export const CompleteAttemptAccepted = Schema.Struct({
  kind: Schema.Literal("accepted"),
  providerMessageId: Schema.String.check(Schema.isMinLength(1)),
  rfcMessageId: Schema.NullOr(NormalizedRfcMessageId),
});
export type CompleteAttemptAccepted = typeof CompleteAttemptAccepted.Type;

export const CompleteAttemptRejected = Schema.Struct({
  kind: Schema.Literal("rejected"),
  failureClass: Schema.Literal("provider"),
  failureDetail: Schema.NullOr(Schema.String),
});
export type CompleteAttemptRejected = typeof CompleteAttemptRejected.Type;

export const CompleteAttemptUnknown = Schema.Struct({
  kind: Schema.Literal("unknown"),
});
export type CompleteAttemptUnknown = typeof CompleteAttemptUnknown.Type;

export const CompleteAttemptOutcome = Schema.Union([
  CompleteAttemptAccepted,
  CompleteAttemptRejected,
  CompleteAttemptUnknown,
]);
export type CompleteAttemptOutcome = typeof CompleteAttemptOutcome.Type;

export const CompleteAttemptInput = Schema.Struct({
  jobId: Schema.String,
  attemptId: Schema.String,
  nowIso: Schema.String,
  outcome: CompleteAttemptOutcome,
});
export type CompleteAttemptInput = typeof CompleteAttemptInput.Type;

export const CompleteAttemptResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("applied"),
    job: OutboundJob,
  }),
  Schema.Struct({
    kind: Schema.Literal("stale"),
    job: OutboundJob,
  }),
  Schema.Struct({
    kind: Schema.Literal("missing"),
  }),
]);
export type CompleteAttemptResult = typeof CompleteAttemptResult.Type;

export const SettleExpiredInFlightInput = Schema.Struct({
  jobId: Schema.String,
  attemptId: Schema.String,
  nowIso: Schema.String,
});
export type SettleExpiredInFlightInput = typeof SettleExpiredInFlightInput.Type;

export const RejectReadyDispatchInput = Schema.Struct({
  jobId: Schema.String,
  nowIso: Schema.String,
  failureDetail: Schema.NullOr(Schema.String),
});
export type RejectReadyDispatchInput = typeof RejectReadyDispatchInput.Type;

export const RejectReadyDispatchResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("rejected"),
    job: OutboundJob,
  }),
  Schema.Struct({
    kind: Schema.Literal("stale"),
    job: OutboundJob,
  }),
  Schema.Struct({
    kind: Schema.Literal("missing"),
  }),
]);
export type RejectReadyDispatchResult = typeof RejectReadyDispatchResult.Type;

export const StoredNotificationCiphertext = Schema.Struct({
  id: Schema.String,
  approvalId: Schema.String,
  jobId: Schema.String,
  keyVersion: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String,
  expiresAt: Schema.String,
  purgedAt: Schema.NullOr(Schema.String),
});
export type StoredNotificationCiphertext = typeof StoredNotificationCiphertext.Type;

export const OutboundDispatch = Schema.Struct({
  job: OutboundJob,
  subject: Schema.String,
  textBody: Schema.NullOr(Schema.String),
  htmlBody: Schema.NullOr(Schema.String),
  hasRemoteImages: Schema.Boolean,
  from: Schema.NullOr(AccountMailContact),
  replyTo: Schema.NullOr(AccountMailContact),
  to: Schema.Array(AccountMailContact),
  cc: Schema.Array(AccountMailContact),
  inReplyToHeader: Schema.NullOr(Schema.String),
  referencesHeader: Schema.NullOr(Schema.String),
  notification: Schema.NullOr(StoredNotificationCiphertext),
});
export type OutboundDispatch = typeof OutboundDispatch.Type;

export const SendWorkKind = Schema.Literals(["ready", "expired_in_flight"]);
export type SendWorkKind = typeof SendWorkKind.Type;

export const ListDueApprovalsInput = Schema.Struct({
  nowIso: Schema.String,
  limit: Schema.optionalKey(Schema.Finite),
});
export type ListDueApprovalsInput = typeof ListDueApprovalsInput.Type;

export const DueApprovalCursor = Schema.Struct({
  expiresAt: Schema.String,
  approvalId: Schema.String,
});
export type DueApprovalCursor = typeof DueApprovalCursor.Type;

export const ListDueApprovalsPage = Schema.Struct({
  items: Schema.Array(StoredApproval),
  nextCursor: Schema.NullOr(DueApprovalCursor),
});
export type ListDueApprovalsPage = typeof ListDueApprovalsPage.Type;

export const ListPurgeableNotificationsInput = Schema.Struct({
  nowIso: Schema.String,
  limit: Schema.optionalKey(Schema.Finite),
});
export type ListPurgeableNotificationsInput = typeof ListPurgeableNotificationsInput.Type;

export const NotificationPurgeCursor = Schema.Struct({
  createdAt: Schema.String,
  notificationId: Schema.String,
});
export type NotificationPurgeCursor = typeof NotificationPurgeCursor.Type;

export const ListPurgeableNotificationsPage = Schema.Struct({
  items: Schema.Array(StoredNotificationCiphertext),
  nextCursor: Schema.NullOr(NotificationPurgeCursor),
});
export type ListPurgeableNotificationsPage = typeof ListPurgeableNotificationsPage.Type;

export const PurgeNotificationCiphertextInput = Schema.Struct({
  notificationId: Schema.String,
  nowIso: Schema.String,
});
export type PurgeNotificationCiphertextInput = typeof PurgeNotificationCiphertextInput.Type;

export const PurgeNotificationCiphertextResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("purged"),
    notificationId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("already_purged"),
    notificationId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("missing"),
  }),
]);
export type PurgeNotificationCiphertextResult = typeof PurgeNotificationCiphertextResult.Type;

export const JobListCursor = Schema.Struct({
  createdAt: UtcInstant,
  jobId: Schema.String,
});
export type JobListCursor = typeof JobListCursor.Type;

export const ListSendWorkInput = Schema.Struct({
  kind: SendWorkKind,
  nowIso: Schema.String,
  limit: Schema.optionalKey(Schema.Finite),
  cursor: Schema.optionalKey(JobListCursor),
});
export type ListSendWorkInput = typeof ListSendWorkInput.Type;

export const ListSendWorkPage = Schema.Struct({
  items: Schema.Array(OutboundJob),
  nextCursor: Schema.NullOr(JobListCursor),
});
export type ListSendWorkPage = typeof ListSendWorkPage.Type;

export const ListOutboundJobsQuery = Schema.Struct({
  viewer: JobViewer,
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(JobListCursor),
});
export type ListOutboundJobsQuery = typeof ListOutboundJobsQuery.Type;

export const OutboundJobPage = Schema.Struct({
  items: Schema.Array(OutboundJob),
  nextCursor: Schema.NullOr(JobListCursor),
});
export type OutboundJobPage = typeof OutboundJobPage.Type;

export const DecideApprovalInput = Schema.Struct({
  tokenHash: ApprovalTokenHash,
  decision: ApprovalDecision,
  nowIso: Schema.String,
});
export type DecideApprovalInput = typeof DecideApprovalInput.Type;

export const ExpireApprovalInput = Schema.Struct({
  approvalId: Schema.String,
  nowIso: Schema.String,
});
export type ExpireApprovalInput = typeof ExpireApprovalInput.Type;

export const CancelApprovalNotificationInput = Schema.Struct({
  approvalId: Schema.String,
  nowIso: Schema.String,
});
export type CancelApprovalNotificationInput = typeof CancelApprovalNotificationInput.Type;

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
  node_id: Schema.NullOr(Schema.String),
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

export const ApprovalNotificationRow = Schema.Struct({
  id: Schema.String,
  approval_id: Schema.String,
  job_id: Schema.String,
  key_version: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String,
  expires_at: Schema.String,
  created_at: Schema.String,
  purged_at: Schema.NullOr(Schema.String),
});
export type ApprovalNotificationRow = typeof ApprovalNotificationRow.Type;
