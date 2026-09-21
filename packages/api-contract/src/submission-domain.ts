import * as Schema from "effect/Schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SubmissionRequestId = Schema.String.check(Schema.isPattern(UUID)).pipe(
  Schema.brand("SubmissionRequestId"),
);
export type SubmissionRequestId = typeof SubmissionRequestId.Type;

export function approvalNotificationIdempotencyKey(requestId: SubmissionRequestId): string {
  return `${requestId}:approval-notification`;
}

export const OutboundJobState = Schema.Literals([
  "waiting_approval",
  "ready",
  "in_flight",
  "accepted",
  "rejected",
  "unknown",
]);
export type OutboundJobState = typeof OutboundJobState.Type;

export const OutboundJobPurpose = Schema.Literals(["message", "approval_notification"]);
export type OutboundJobPurpose = typeof OutboundJobPurpose.Type;

export const OutboundJobFailureClass = Schema.Literals([
  "denied",
  "expired",
  "cancelled",
  "notification_failed",
  "policy",
  "provider",
]);
export type OutboundJobFailureClass = typeof OutboundJobFailureClass.Type;

export const ApprovalState = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export type ApprovalState = typeof ApprovalState.Type;
