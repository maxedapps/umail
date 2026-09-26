import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

// What the CLI says when the server cannot be reached or answers outside the API contract. Each
// names the step, what came back, and what to do.

export class ServerUnreachable extends Data.TaggedError("ServerUnreachable")<{
  readonly origin: string;
  readonly step: string;
  readonly code: string | undefined;
}> {
  override readonly message = `Could not reach ${this.origin} during ${this.step}${
    this.code === undefined ? "" : ` (${this.code})`
  }. Check that the server is up and UMAIL_URL is right.`;
}

export class ServerFailed extends Data.TaggedError("ServerFailed")<{
  readonly status: number;
  readonly step: string;
}> {
  override readonly message =
    this.status === 429
      ? `The umail server rate-limited ${this.step} (HTTP 429). Try again shortly.`
      : `The umail server failed (HTTP ${this.status}) on ${this.step}. Try again later.`;
}

export class UnexpectedResponse extends Data.TaggedError("UnexpectedResponse")<{
  readonly detail: string;
}> {
  override readonly message = `Unexpected response from the umail server: ${this.detail}. Update the CLI or check UMAIL_URL.`;
}

export type ServerError = ServerUnreachable | ServerFailed | UnexpectedResponse;

// "GET /threads": the request, without its query or credentials.
function requestStep(request: HttpClientRequest.HttpClientRequest): string {
  return `${request.method} ${URL.parse(request.url)?.pathname ?? request.url}`;
}

// One mapping for every HTTP failure the CLI sees, from the API client and the OAuth requests.
// A request the CLI could not even build is its own bug, so it is a defect.
export function fromHttpClientError(
  error: HttpClientError.HttpClientError,
  step = requestStep(error.reason.request),
): Effect.Effect<never, ServerError> {
  const reason = error.reason;
  switch (reason._tag) {
    case "TransportError":
      return Effect.fail(
        new ServerUnreachable({
          origin: URL.parse(reason.request.url)?.origin ?? reason.request.url,
          step,
          code: networkCode(reason.cause),
        }),
      );
    case "StatusCodeError":
    case "DecodeError":
    case "EmptyBodyError":
      return reason.response.status >= 400
        ? Effect.fail(new ServerFailed({ status: reason.response.status, step }))
        : Effect.fail(
            new UnexpectedResponse({
              detail: `${step} answered HTTP ${reason.response.status} with a body the CLI cannot read`,
            }),
          );
    case "EncodeError":
    case "InvalidUrlError":
      return Effect.die(error);
  }
}

// The first issue of a body that does not match the contract, e.g. "items.0.threadId: Expected
// string".
export function schemaIssueText(error: Schema.SchemaError): string {
  const [issue] = formatIssue(error.issue).issues;
  const path = issue?.path?.map(String).join(".") ?? "";
  const message = issue?.message ?? "";
  return path.length === 0 ? message : `${path}: ${message}`;
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

// undici puts ECONNREFUSED, ENOTFOUND or UND_ERR_CONNECT_TIMEOUT on the error it throws, or on the
// first error of an AggregateError when every address of a host failed.
function networkCode(cause: unknown): string | undefined {
  const failure =
    Predicate.hasProperty(cause, "errors") && Array.isArray(cause.errors) ? cause.errors[0] : cause;
  const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
  const firstCode = Predicate.hasProperty(failure, "code") ? failure.code : undefined;
  const found = code ?? firstCode;
  return typeof found === "string" ? found : undefined;
}
