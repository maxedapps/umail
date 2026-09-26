import * as Schema from "effect/Schema";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";

// One error class per status; each carries a stable `code` and a `message` written where the cause
// is known, which every surface (REST, CLI, MCP, web) shows as is. `code` is a plain string on the
// wire so a client decodes codes it does not know; the constructors take only the codes below.
const fields = { code: Schema.String, message: Schema.String };

type InvalidRequestCode =
  | "invalid_request"
  | "invalid_cursor"
  | "address_invalid"
  | "address_reserved"
  | "from_address_unknown"
  | "from_address_inactive"
  | "too_many_recipients"
  | "html_too_complex"
  | "html_unsafe"
  | "no_external_recipients"
  | "forwarding_rejected";
type UnauthenticatedCode = "token_invalid";
type NotPermittedCode =
  | "read_denied"
  | "send_denied"
  | "mailbox_forbidden"
  | "recipient_not_allowed"
  | "client_inactive"
  | "insufficient_scope";
export type NotFoundCode =
  | "thread_not_found"
  | "message_not_found"
  | "job_not_found"
  | "attachment_not_found"
  | "mailbox_not_found"
  | "source_not_found"
  | "client_not_found";
type ConflictCode = "address_exists" | "request_id_reused" | "no_archived_source";
type UnavailableCode =
  | "archive_unavailable"
  | "cloudflare_unavailable"
  | "cloudflare_misconfigured";

type Props<Code> = { readonly code: Code; readonly message: string };

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", fields, {
  httpApiStatus: 400,
}) {
  constructor(props: Props<InvalidRequestCode>, options?: Schema.MakeOptions) {
    super(props, options);
  }
}

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  fields,
  { httpApiStatus: 401 },
) {
  constructor(props: Props<UnauthenticatedCode>, options?: Schema.MakeOptions) {
    super(props, options);
  }
}

export class NotPermitted extends Schema.TaggedError<NotPermitted>()("NotPermitted", fields, {
  httpApiStatus: 403,
}) {
  constructor(props: Props<NotPermittedCode>, options?: Schema.MakeOptions) {
    super(props, options);
  }
}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", fields, {
  httpApiStatus: 404,
}) {
  constructor(props: Props<NotFoundCode>, options?: Schema.MakeOptions) {
    super(props, options);
  }
}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", fields, {
  httpApiStatus: 409,
}) {
  constructor(props: Props<ConflictCode>, options?: Schema.MakeOptions) {
    super(props, options);
  }
}

export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", fields, {
  httpApiStatus: 502,
}) {
  constructor(props: Props<UnavailableCode>, options?: Schema.MakeOptions) {
    super(props, options);
  }
}

export const ApiError = Schema.Union([
  InvalidRequest,
  Unauthenticated,
  NotPermitted,
  NotFound,
  Conflict,
  Unavailable,
]);
export type ApiError = typeof ApiError.Type;

export const isApiError = Schema.is(ApiError);

// Declares the 400 every endpoint can answer when its params, query or payload do not decode; the
// server's layer turns the schema issue into a one-line message.
export class RequestErrors extends HttpApiMiddleware.Service<RequestErrors>()(
  "umail/RequestErrors",
  { error: InvalidRequest },
) {}
