import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";

export class SchemaIncompatibleError extends Data.TaggedError("SchemaIncompatibleError")<{
  readonly schemaVersion: number;
  readonly supportedVersion: number;
}> {}

export class SchemaMigrationError extends Data.TaggedError("SchemaMigrationError")<{
  readonly version: number;
  readonly name: string;
  readonly cause: unknown;
}> {}

export class MessageConflictError extends Data.TaggedError("MessageConflictError")<{
  readonly messageId: string;
}> {}

export class InboundMessageIntegrityError extends Data.TaggedError("InboundMessageIntegrityError")<{
  readonly messageId: string;
  readonly reason: "receipt_missing";
}> {}

export class ThreadHandleError extends Data.TaggedError("ThreadHandleError")<{
  readonly handle: string;
  readonly reason: "not_found";
}> {}

export class AccountConflictError extends Data.TaggedError("AccountConflictError")<{
  readonly resource: "address" | "destination";
  readonly id: string;
}> {}

export const JobAuthorizationReason = [
  "send_denied",
  "recipient_not_allowed",
  "mailbox_forbidden",
  "client_inactive",
] as const;
export type JobAuthorizationReason = (typeof JobAuthorizationReason)[number];

export class JobAuthorizationError extends Data.TaggedError("JobAuthorizationError")<{
  readonly reason: JobAuthorizationReason;
}> {}

export class SubmissionConflictError extends Data.TaggedError("SubmissionConflictError")<{
  readonly requestId: string;
  readonly requesterClientId: string;
}> {}

export type AccountStoreError =
  | ThreadHandleError
  | JobAuthorizationError
  | AccountConflictError
  | SubmissionConflictError
  | MessageConflictError;

export const EXPECTED_TAGS = [
  "ThreadHandleError",
  "JobAuthorizationError",
  "AccountConflictError",
  "SubmissionConflictError",
  "MessageConflictError",
] as const satisfies ReadonlyArray<AccountStoreError["_tag"]>;

// Tag-based so it also matches the plain `{ _tag, ... }` envelopes that arrive over RPC.
export const isExpectedStoreFailure = (u: unknown): u is AccountStoreError =>
  EXPECTED_TAGS.some((tag) => Predicate.isTagged(u, tag));
