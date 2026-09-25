import { OFFLINE_ACCESS_SCOPE, UMAIL_CLI_CLIENT_ID, UMAIL_OAUTH_SCOPE } from "@umail/api-contract";
import { umailBaseUrl } from "@umail/api-contract/client";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { OAuthCredentialStore } from "./credential-store.ts";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code" as const;
const REFRESH_GRANT = "refresh_token" as const;
const REQUIRED_SCOPE = `${UMAIL_OAUTH_SCOPE} ${OFFLINE_ACCESS_SCOPE}` as const;
const REFRESH_SKEW_MS = 30_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
const OAUTH_HTTP_TIMEOUT = Duration.seconds(5);
const REVOCATION_TIMEOUT = Duration.seconds(3);

const OAuthMetadata = Schema.Struct({
  issuer: Schema.String,
  device_authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  revocation_endpoint: Schema.String,
});

const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Finite,
  interval: Schema.Finite,
});

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  token_type: Schema.String,
  expires_in: Schema.Finite,
  scope: Schema.optionalKey(Schema.String),
});

const OAuthError = Schema.Literals([
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
  "invalid_grant",
  "invalid_request",
  "invalid_client",
  "invalid_scope",
  "invalid_target",
]);
const OAuthErrorResponse = Schema.Struct({ error: OAuthError });

type OAuthError = typeof OAuthError.Type;

class OAuthLoginRequiredError extends Data.TaggedError("OAuthLoginRequiredError") {
  override readonly message = "OAuth login required. Run: umail login";
}
class OAuthProtocolError extends Data.TaggedError("OAuthProtocolError") {
  override readonly message = "The OAuth server returned an invalid response.";
}
class OAuthAccessDeniedError extends Data.TaggedError("OAuthAccessDeniedError") {
  override readonly message = "Device authorization was denied.";
}
class OAuthDeviceCodeExpiredError extends Data.TaggedError("OAuthDeviceCodeExpiredError") {
  override readonly message = "The device authorization code expired. Run: umail login";
}
class OAuthRevocationError extends Data.TaggedError("OAuthRevocationError") {
  override readonly message =
    "Could not revoke access on the server; local OAuth credentials were kept. Try again.";
}

export interface OAuthSchedulerService {
  readonly now: Effect.Effect<number>;
  readonly sleep: (milliseconds: number) => Effect.Effect<void>;
}
export class OAuthScheduler extends Context.Service<OAuthScheduler, OAuthSchedulerService>()(
  "umail/OAuthScheduler",
) {
  static readonly layer = Layer.effect(
    OAuthScheduler,
    Effect.map(Clock.Clock, (clock) => ({
      now: clock.currentTimeMillis,
      sleep: (milliseconds: number) => clock.sleep(Duration.millis(milliseconds)),
    })),
  );
}

// Device login as the static CLI client. The browser approval can take minutes, so only the final
// write holds the credential lock.
export const login = Effect.gen(function* () {
  const baseUrl = yield* umailBaseUrl;
  const httpClient = yield* HttpClient.HttpClient;
  const store = yield* OAuthCredentialStore;
  const scheduler = yield* OAuthScheduler;
  const metadata = yield* discoverOAuth(httpClient, baseUrl);
  const device = yield* requestJson(
    httpClient,
    HttpClientRequest.post(metadata.device_authorization_endpoint).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: UMAIL_CLI_CLIENT_ID,
        resource: baseUrl,
        scope: REQUIRED_SCOPE,
      }),
    ),
    DeviceCodeResponse,
  );
  if (
    device.expires_in <= 0 ||
    device.interval <= 0 ||
    !isDeviceVerificationUrl(device.verification_uri, baseUrl) ||
    !isDeviceVerificationUrl(device.verification_uri_complete, baseUrl)
  ) {
    return yield* new OAuthProtocolError();
  }
  const startedAt = yield* scheduler.now;
  yield* Console.log(`Open: ${device.verification_uri_complete}`);
  yield* Console.log(`Code: ${device.user_code}`);
  yield* Console.log("Waiting for approval…");
  const tokens = yield* pollForTokens(
    httpClient,
    scheduler,
    metadata.token_endpoint,
    baseUrl,
    device,
    startedAt,
  );
  const now = yield* scheduler.now;
  const refreshToken = tokens.refresh_token;
  const scope = tokens.scope ?? REQUIRED_SCOPE;
  if (
    tokens.token_type.toLowerCase() !== "bearer" ||
    tokens.expires_in <= 0 ||
    !hasRequiredScopes(scope) ||
    refreshToken === undefined ||
    refreshToken.length === 0
  ) {
    return yield* new OAuthProtocolError();
  }
  yield* store.withLock(
    store.write({
      origin: baseUrl,
      scope,
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt: now + tokens.expires_in * 1_000,
    }),
  );
}).pipe(Effect.catchTag("OAuthEndpointError", () => new OAuthProtocolError()));

// The current access token, refreshed under the credential lock when it is about to expire.
export const accessToken = Effect.gen(function* () {
  const baseUrl = yield* umailBaseUrl;
  const store = yield* OAuthCredentialStore;
  const scheduler = yield* OAuthScheduler;
  return yield* store.withLock(
    Effect.gen(function* () {
      const credentials = yield* store.read;
      if (credentials === null || credentials.origin !== baseUrl) {
        return yield* new OAuthLoginRequiredError();
      }
      if (!hasRequiredScopes(credentials.scope)) {
        return yield* new OAuthProtocolError();
      }
      const now = yield* scheduler.now;
      if (credentials.expiresAt - now > REFRESH_SKEW_MS) {
        return Redacted.make(credentials.accessToken);
      }
      const httpClient = yield* HttpClient.HttpClient;
      const metadata = yield* discoverOAuth(httpClient, baseUrl);
      const refreshed = yield* requestJson(
        httpClient,
        HttpClientRequest.post(metadata.token_endpoint).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: REFRESH_GRANT,
            refresh_token: credentials.refreshToken,
            client_id: UMAIL_CLI_CLIENT_ID,
            resource: baseUrl,
          }),
        ),
        OAuthTokenResponse,
      ).pipe(
        Effect.catchTag("OAuthEndpointError", (error) =>
          Effect.fail(
            error.error === "invalid_grant" || error.error === "invalid_client"
              ? new OAuthLoginRequiredError()
              : new OAuthProtocolError(),
          ),
        ),
      );
      const scope = refreshed.scope ?? credentials.scope;
      if (
        refreshed.token_type.toLowerCase() !== "bearer" ||
        refreshed.expires_in <= 0 ||
        !hasRequiredScopes(scope)
      ) {
        return yield* new OAuthProtocolError();
      }
      const next = {
        origin: baseUrl,
        scope,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? credentials.refreshToken,
        expiresAt: now + refreshed.expires_in * 1_000,
      };
      yield* store.write(next);
      return Redacted.make(next.accessToken);
    }),
  );
});

// Revokes on the server first; the local tokens are removed only once that succeeded.
export const logout = Effect.gen(function* () {
  const baseUrl = yield* umailBaseUrl;
  const store = yield* OAuthCredentialStore;
  const httpClient = yield* HttpClient.HttpClient;
  yield* store.withLock(
    Effect.gen(function* () {
      const credentials = yield* store.read;
      if (credentials === null || credentials.origin !== baseUrl) return;
      yield* revokeRefreshToken(httpClient, baseUrl, credentials.refreshToken).pipe(
        Effect.mapError(() => new OAuthRevocationError()),
      );
      yield* store.remove;
    }),
  );
});

const revokeRefreshToken = Effect.fn("revokeRefreshToken")(
  function* (httpClient: HttpClient.HttpClient, baseUrl: string, refreshToken: string) {
    const metadata = yield* discoverOAuth(httpClient, baseUrl);
    const response = yield* httpClient.execute(
      HttpClientRequest.post(metadata.revocation_endpoint).pipe(
        HttpClientRequest.bodyUrlParams({
          token: refreshToken,
          token_type_hint: "refresh_token",
          client_id: UMAIL_CLI_CLIENT_ID,
        }),
      ),
    );
    yield* response.arrayBuffer.pipe(Effect.asVoid, Effect.ignore);
    if (response.status < 200 || response.status >= 300) return yield* new OAuthProtocolError();
  },
  Effect.timeout(REVOCATION_TIMEOUT),
  Effect.catchTag("TimeoutError", () => new OAuthProtocolError()),
);

function discoverOAuth(httpClient: HttpClient.HttpClient, baseUrl: string) {
  return requestJson(
    httpClient,
    HttpClientRequest.get(
      new URL("/.well-known/oauth-authorization-server/api/auth", `${baseUrl}/`),
    ),
    OAuthMetadata,
  ).pipe(
    Effect.catchTag("OAuthEndpointError", () => new OAuthProtocolError()),
    Effect.filterOrFail(
      (metadata) =>
        metadata.issuer === `${baseUrl}/api/auth` &&
        isSameOriginUrl(metadata.device_authorization_endpoint, baseUrl) &&
        isSameOriginUrl(metadata.token_endpoint, baseUrl) &&
        isSameOriginUrl(metadata.revocation_endpoint, baseUrl),
      () => new OAuthProtocolError(),
    ),
  );
}

function hasRequiredScopes(scope: string): boolean {
  const scopes = new Set(scope.split(" ").filter((value) => value.length > 0));
  return scopes.has(UMAIL_OAUTH_SCOPE) && scopes.has(OFFLINE_ACCESS_SCOPE);
}

function isSameOriginUrl(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}
function isDeviceVerificationUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === origin && url.pathname === "/device";
  } catch {
    return false;
  }
}

const pollForTokens = Effect.fn("pollForTokens")(function* (
  httpClient: HttpClient.HttpClient,
  scheduler: OAuthSchedulerService,
  tokenEndpoint: string,
  resource: string,
  device: typeof DeviceCodeResponse.Type,
  startedAt: number,
) {
  let intervalMs = Math.max(1, device.interval) * 1_000;
  const expiresAt = startedAt + device.expires_in * 1_000;
  while (true) {
    yield* scheduler.sleep(intervalMs);
    const now = yield* scheduler.now;
    if (now >= expiresAt) return yield* new OAuthDeviceCodeExpiredError();
    const response = yield* executeOAuth(
      httpClient,
      HttpClientRequest.post(tokenEndpoint).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: DEVICE_GRANT,
          device_code: device.device_code,
          client_id: UMAIL_CLI_CLIENT_ID,
          resource,
        }),
      ),
    );
    if (response.status >= 200 && response.status < 300) {
      return yield* decodeResponse(response, OAuthTokenResponse);
    }
    const error = yield* decodeResponse(response, OAuthErrorResponse);
    if (error.error === "authorization_pending") continue;
    if (error.error === "slow_down") {
      intervalMs += SLOW_DOWN_INCREMENT_MS;
      continue;
    }
    if (error.error === "access_denied") return yield* new OAuthAccessDeniedError();
    if (error.error === "expired_token") return yield* new OAuthDeviceCodeExpiredError();
    return yield* new OAuthEndpointError({ error: error.error });
  }
});

const requestJson = Effect.fn("requestJson")(function* <S extends Schema.Top>(
  httpClient: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) {
  const response = yield* executeOAuth(httpClient, request);
  if (response.status < 200 || response.status >= 300) {
    const error = yield* decodeResponse(response, OAuthErrorResponse);
    return yield* new OAuthEndpointError({ error: error.error });
  }
  return yield* decodeResponse(response, schema);
});

function executeOAuth(
  httpClient: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
) {
  return httpClient.execute(request).pipe(
    Effect.mapError(() => new OAuthProtocolError()),
    Effect.timeout(OAUTH_HTTP_TIMEOUT),
    Effect.catchTag("TimeoutError", () => new OAuthProtocolError()),
  );
}

function decodeResponse<S extends Schema.Top>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
) {
  return HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.mapError(() => new OAuthProtocolError()),
  );
}

class OAuthEndpointError extends Data.TaggedError("OAuthEndpointError")<{
  readonly error: OAuthError;
}> {
  override readonly message = "The OAuth endpoint rejected the request.";
}
