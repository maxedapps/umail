import { MailboxAddress } from "@umail/api-contract";
import * as Schema from "effect/Schema";

export const ForwardNone = Schema.Struct({
  kind: Schema.Literal("none"),
});

export const ForwardSuccess = Schema.Struct({
  kind: Schema.Literal("success"),
  destination: Schema.String,
});

export const ForwardFailure = Schema.Struct({
  kind: Schema.Literal("failure"),
  destination: Schema.String,
  error: Schema.String,
});

export const ForwardOutcome = Schema.Union([ForwardNone, ForwardSuccess, ForwardFailure]);
export type ForwardOutcome = typeof ForwardOutcome.Type;

export const Envelope = Schema.Struct({
  from: Schema.String,
  to: MailboxAddress,
});
export type Envelope = typeof Envelope.Type;

export const IndexPayload = Schema.Struct({
  key: Schema.String,
  digest: Schema.String,
  envelope: Envelope,
  receivedAt: Schema.String,
  forwardOutcome: ForwardOutcome,
});
export type IndexPayload = typeof IndexPayload.Type;

export const IndexReceiptWork = Schema.Struct({
  version: Schema.Literal(1),
  receiptId: Schema.String,
});
export type IndexReceiptWork = typeof IndexReceiptWork.Type;
