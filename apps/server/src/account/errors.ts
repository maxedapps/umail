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

// A stored message is missing the record that must accompany it: an inbound receipt or an
// outbound job.
export class MessageIntegrityError extends Data.TaggedError("MessageIntegrityError")<{
  readonly messageId: string;
  readonly reason: "receipt_missing" | "job_missing";
}> {}

export class ThreadNotFoundError extends Data.TaggedError("ThreadNotFoundError")<{
  readonly threadId: string;
}> {}

export class AccountConflictError extends Data.TaggedError("AccountConflictError")<{
  readonly address: string;
}> {}

export const JobAuthorizationReason = [
  "send_denied",
  "recipient_not_allowed",
  "mailbox_forbidden",
  "client_inactive",
] as const;
export type JobAuthorizationReason = (typeof JobAuthorizationReason)[number];

// `addresses` lists the rejected recipients for `recipient_not_allowed`, and is empty otherwise.
export class JobAuthorizationError extends Data.TaggedError("JobAuthorizationError")<{
  readonly reason: JobAuthorizationReason;
  readonly addresses: ReadonlyArray<string>;
}> {}

export class SubmissionConflictError extends Data.TaggedError("SubmissionConflictError")<{
  readonly requestId: string;
  readonly requesterClientId: string;
}> {}

export type AccountStoreError =
  | ThreadNotFoundError
  | JobAuthorizationError
  | AccountConflictError
  | SubmissionConflictError
  | MessageConflictError;

const EXPECTED_TAGS = [
  "ThreadNotFoundError",
  "JobAuthorizationError",
  "AccountConflictError",
  "SubmissionConflictError",
  "MessageConflictError",
] as const satisfies ReadonlyArray<AccountStoreError["_tag"]>;

// Tag-based so it also matches the plain `{ _tag, ... }` envelopes that arrive over RPC.
export const isExpectedStoreFailure = (u: unknown): u is AccountStoreError =>
  EXPECTED_TAGS.some((tag) => Predicate.isTagged(u, tag));
