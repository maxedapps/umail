import * as Schema from "effect/Schema";

export class LocalTargetFlowObservation extends Schema.Class<LocalTargetFlowObservation>(
  "LocalTargetFlowObservation",
)({
  loginFinalPath: Schema.String,
  policyLabel: Schema.String,
  policySendMode: Schema.String,
  inboundMessageId: Schema.String,
  inboundAttachmentId: Schema.String,
  inboundAttachmentContentType: Schema.String,
  inboundAttachmentByteLength: Schema.Finite,
  replyJobId: Schema.String,
  replyStateAfterSubmit: Schema.String,
  approvalAfterDecision: Schema.String,
  approvalAfterSend: Schema.String,
  providerCalls: Schema.Finite,
  jobState: Schema.String,
  jobProviderMessageId: Schema.NullOr(Schema.String),
  attachmentContentType: Schema.String,
  attachmentMatchesPng: Schema.Boolean,
}) {}

export class LocalTargetRegressionObservation extends Schema.Class<LocalTargetRegressionObservation>(
  "LocalTargetRegressionObservation",
)({
  signupStatus: Schema.Finite,
  wrongPasswordStatus: Schema.String,
  hostilePolicyStatus: Schema.Finite,
  policyLabelAfterHostilePost: Schema.String,
  inboundMessageCountAfterDuplicateIndex: Schema.Finite,
  providerCallsAfterApprovalReplay: Schema.Finite,
}) {}

declare module "vitest/browser" {
  interface BrowserCommands {
    runLocalTargetFlow(): Promise<LocalTargetFlowObservation>;
    probeLocalTargetRegressions(): Promise<LocalTargetRegressionObservation>;
  }
}
