import {
  makePublicApprovalClient,
  makeUmailClient,
  umailBaseUrl,
} from "@umail/api-contract/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { accessToken } from "./auth.ts";
import {
  UnexpectedResponse,
  fromHttpClientError,
  schemaIssueText,
  type ServerError,
} from "./errors.ts";

export const umailClient = Effect.fn("umailClient")(function* (httpClient: HttpClient.HttpClient) {
  const baseUrl = yield* umailBaseUrl;
  const token = yield* accessToken;
  return yield* makeUmailClient({ baseUrl, accessToken: token }, httpClient);
});

// An API call's own errors (with the server's message) pass through; a transport failure, an
// undeclared status or a body outside the contract becomes a CLI error that says so.
export function apiCall<A, E, R>(
  call: Effect.Effect<A, E | HttpClientError.HttpClientError | Schema.SchemaError, R>,
): Effect.Effect<A, E | ServerError, R> {
  return Effect.catch(call, (error): Effect.Effect<never, E | ServerError> => {
    if (HttpClientError.isHttpClientError(error)) return fromHttpClientError(error);
    if (Schema.isSchemaError(error)) {
      return Effect.fail(new UnexpectedResponse({ detail: schemaIssueText(error) }));
    }
    return Effect.fail(error);
  });
}

export function publicApprovalClient(httpClient: HttpClient.HttpClient) {
  return Effect.flatMap(umailBaseUrl, (baseUrl) =>
    makePublicApprovalClient({ baseUrl }, httpClient),
  );
}
