import * as Data from "effect/Data";

export class SchemaIncompatibleError extends Data.TaggedError("SchemaIncompatibleError")<{
  readonly schemaVersion: number;
  readonly supportedVersion: number;
}> {}

export class SchemaMigrationError extends Data.TaggedError("SchemaMigrationError")<{
  readonly version: number;
  readonly name: string;
  readonly cause: unknown;
}> {}

export class AccountIdentityError extends Data.TaggedError("AccountIdentityError")<{
  readonly message: string;
}> {}

export class CommandConflictError extends Data.TaggedError("CommandConflictError")<{
  readonly groupId: string;
  readonly id: string;
}> {}

export class MessageConflictError extends Data.TaggedError("MessageConflictError")<{
  readonly messageId: string;
}> {}

export class InboundMessageIntegrityError extends Data.TaggedError("InboundMessageIntegrityError")<{
  readonly messageId: string;
  readonly reason: "receipt_missing" | "forward_observation_invalid";
}> {}

export class ThreadHandleError extends Data.TaggedError("ThreadHandleError")<{
  readonly handle: string;
  readonly reason: "invalid" | "not_found";
}> {}

export class QueryInputError extends Data.TaggedError("QueryInputError")<{
  readonly reason: "invalid_since" | "invalid_query";
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
  "approval_material_required",
] as const;
export type JobAuthorizationReason = (typeof JobAuthorizationReason)[number];

export class JobAuthorizationError extends Data.TaggedError("JobAuthorizationError")<{
  readonly reason: JobAuthorizationReason;
}> {}

export class SubmissionConflictError extends Data.TaggedError("SubmissionConflictError")<{
  readonly requestId: string;
  readonly requesterClientId: string;
}> {}

export class AccountStoreUnexpectedError extends Data.TaggedError("AccountStoreUnexpectedError")<{
  readonly cause: unknown;
}> {}

export type AccountStoreError =
  | SchemaIncompatibleError
  | SchemaMigrationError
  | AccountIdentityError
  | CommandConflictError
  | MessageConflictError
  | InboundMessageIntegrityError
  | ThreadHandleError
  | QueryInputError
  | AccountConflictError
  | JobAuthorizationError
  | SubmissionConflictError
  | AccountStoreUnexpectedError;

export function toAccountStoreError(cause: unknown): AccountStoreError {
  if (cause instanceof SchemaIncompatibleError) return cause;
  if (cause instanceof SchemaMigrationError) return cause;
  if (cause instanceof AccountIdentityError) return cause;
  if (cause instanceof CommandConflictError) return cause;
  if (cause instanceof MessageConflictError) return cause;
  if (cause instanceof InboundMessageIntegrityError) return cause;
  if (cause instanceof ThreadHandleError) return cause;
  if (cause instanceof QueryInputError) return cause;
  if (cause instanceof AccountConflictError) return cause;
  if (cause instanceof JobAuthorizationError) return cause;
  if (cause instanceof SubmissionConflictError) return cause;
  if (cause instanceof AccountStoreUnexpectedError) return cause;
  return new AccountStoreUnexpectedError({ cause });
}
