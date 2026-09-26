import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { PublicApprovalApi, UmailApi } from "./api-spec.ts";

export interface UmailClientConfig {
  readonly baseUrl: string;
  readonly accessToken: Redacted.Redacted<string>;
}

interface PublicApprovalClientConfig {
  readonly baseUrl: string;
}

interface UmailClientConfigurationErrorFields {
  readonly message: string;
}

class UmailClientConfigurationError extends Data.TaggedError(
  "UmailClientConfigurationError",
)<UmailClientConfigurationErrorFields> {}

function parseBaseUrl(value: string) {
  const origin = new UmailClientConfigurationError({
    message: `UMAIL_URL "${value}" must be an HTTP(S) origin like https://mail.example.com, with no path.`,
  });
  return Schema.decodeEffect(Schema.URLFromString)(value).pipe(
    Effect.mapError(() => origin),
    Effect.filterOrFail(
      (url) =>
        (url.protocol === "https:" || url.protocol === "http:") && url.href === `${url.origin}/`,
      () => origin,
    ),
    Effect.filterOrFail(
      (url) =>
        url.protocol === "https:" ||
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]",
      () =>
        new UmailClientConfigurationError({
          message: `UMAIL_URL "${value}" must use HTTPS except on localhost, 127.0.0.1, or [::1].`,
        }),
    ),
    Effect.map((url) => url.origin),
  );
}

// The AgentMail origin, from UMAIL_URL.
export const umailBaseUrl: Effect.Effect<string, UmailClientConfigurationError> = Config.option(
  Config.string("UMAIL_URL"),
).pipe(
  Effect.mapError(
    () => new UmailClientConfigurationError({ message: "UMAIL_URL could not be read." }),
  ),
  Effect.flatMap(
    Option.match({
      onNone: () =>
        Effect.fail(
          new UmailClientConfigurationError({
            message:
              "UMAIL_URL is required. Set it to your AgentMail origin, e.g. https://mail.example.com.",
          }),
        ),
      onSome: parseBaseUrl,
    }),
  ),
);

function withUmailRequestHeaders(client: HttpClient.HttpClient, config: UmailClientConfig) {
  return HttpClient.mapRequest(client, (request) =>
    request.pipe(
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.bearerToken(config.accessToken),
    ),
  );
}

export function makeUmailClient(config: UmailClientConfig, httpClient: HttpClient.HttpClient) {
  return HttpApiClient.makeWith(UmailApi, {
    baseUrl: config.baseUrl,
    httpClient: withUmailRequestHeaders(httpClient, config),
  });
}

export function makePublicApprovalClient(
  config: PublicApprovalClientConfig,
  httpClient: HttpClient.HttpClient,
) {
  const manualRedirectClient = HttpClient.transform(httpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );
  return HttpApiClient.makeWith(PublicApprovalApi, {
    baseUrl: config.baseUrl,
    httpClient: manualRedirectClient,
  });
}
