import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

// Explicit ranges, not the `i` flag: JSON Schema patterns have no flags, and MCP validates tool
// arguments against this pattern before decoding. Decoding lower-cases the id.
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const SubmissionRequestId = Schema.String.check(
  Schema.isPattern(UUID, { expected: "a UUID" }),
).pipe(Schema.decode(SchemaTransformation.toLowerCase()), Schema.brand("SubmissionRequestId"));
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
