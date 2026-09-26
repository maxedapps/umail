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
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { OAuthCredentialStore } from "./credential-store.ts";
import { ServerFailed, ServerUnreachable, fromHttpClientError, schemaIssueText } from "./errors.ts";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code" as const;
const REFRESH_GRANT = "refresh_token" as const;
const REQUIRED_SCOPE = `${UMAIL_OAUTH_SCOPE} ${OFFLINE_ACCESS_SCOPE}` as const;
const REFRESH_SKEW_MS = 30_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
const OAUTH_HTTP_TIMEOUT = Duration.seconds(5);
const REVOCATION_TIMEOUT = Duration.seconds(3);
const POLL_TRANSPORT_RETRIES = 3;
const POLL_RETRY_BASE = Duration.millis(500);

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

// RFC 6749 §5.2: any error code, with an optional description.
const OAuthErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
});

// The request each OAuth failure names.
type OAuthStep =
  | "discovery"
  | "device authorization"
  | "sign-in approval"
  | "token refresh"
  | "revocation";

class LoginRequired extends Data.TaggedError("LoginRequired")<{ readonly reason: string }> {
  override readonly message = `${this.reason} Run: umail login`;
}
class OAuthFailed extends Data.TaggedError("OAuthFailed")<{
  readonly step: OAuthStep;
  readonly detail: string;
}> {
  override readonly message = `OAuth ${this.step} failed: ${this.detail}. Try again; if it keeps failing, check UMAIL_URL.`;
}
class OAuthAccessDeniedError extends Data.TaggedError("OAuthAccessDeniedError") {
  override readonly message = "Device authorization was denied in the browser.";
}
class OAuthDeviceCodeExpiredError extends Data.TaggedError("OAuthDeviceCodeExpiredError") {
  override readonly message = "The device authorization code expired. Run: umail login";
}
class OAuthRevocationError extends Data.TaggedError("OAuthRevocationError")<{
  readonly reason: string;
}> {
  override readonly message = `Could not revoke access on the server; local OAuth credentials were kept. ${this.reason}`;
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
    "device authorization",
    HttpClientRequest.post(metadata.device_authorization_endpoint).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: UMAIL_CLI_CLIENT_ID,
        resource: baseUrl,
        scope: REQUIRED_SCOPE,
      }),
    ),
    DeviceCodeResponse,
  ).pipe(Effect.catchTag("OAuthEndpointError", failed));
  if (device.expires_in <= 0 || device.interval <= 0) {
    return yield* new OAuthFailed({
      step: "device authorization",
      detail: `expires_in ${device.expires_in} and interval ${device.interval} must be positive`,
    });
  }
  for (const url of [device.verification_uri, device.verification_uri_complete]) {
    if (!isDeviceVerificationUrl(url, baseUrl)) {
      return yield* new OAuthFailed({
        step: "device authorization",
        detail: `verification URL ${url} is not ${baseUrl}/device`,
      });
    }
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
  const scope = tokens.scope ?? REQUIRED_SCOPE;
  yield* checkTokens("sign-in approval", tokens, scope);
  const refreshToken = tokens.refresh_token;
  if (refreshToken === undefined || refreshToken.length === 0) {
    return yield* new OAuthFailed({ step: "sign-in approval", detail: "no refresh token issued" });
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
});

// The current access token, refreshed under the credential lock when it is about to expire.
export const accessToken = Effect.gen(function* () {
  const baseUrl = yield* umailBaseUrl;
  const store = yield* OAuthCredentialStore;
  const scheduler = yield* OAuthScheduler;
  return yield* store.withLock(
    Effect.gen(function* () {
      const credentials = yield* store.read;
      if (credentials === null) {
        return yield* new LoginRequired({ reason: "Not signed in." });
      }
      if (credentials.origin !== baseUrl) {
        return yield* new LoginRequired({
          reason: `Stored credentials are for ${credentials.origin}, not ${baseUrl}.`,
        });
      }
      if (!hasRequiredScopes(credentials.scope)) {
        return yield* new LoginRequired({
          reason: `Stored credentials lack the ${REQUIRED_SCOPE} scopes.`,
        });
      }
      const now = yield* scheduler.now;
      if (credentials.expiresAt - now > REFRESH_SKEW_MS) {
        return Redacted.make(credentials.accessToken);
      }
      const httpClient = yield* HttpClient.HttpClient;
      const metadata = yield* discoverOAuth(httpClient, baseUrl);
      const refreshed = yield* requestJson(
        httpClient,
        "token refresh",
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
        Effect.catchTag(
          "OAuthEndpointError",
          (error): Effect.Effect<never, LoginRequired | OAuthFailed> =>
            error.error === "invalid_grant" || error.error === "invalid_client"
              ? Effect.fail(
                  new LoginRequired({
                    reason: `The session expired or was revoked (${error.error}).`,
                  }),
                )
              : failed(error),
        ),
      );
      const scope = refreshed.scope ?? credentials.scope;
      yield* checkTokens("token refresh", refreshed, scope);
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
        Effect.mapError((error) => new OAuthRevocationError({ reason: error.message })),
      );
      yield* store.remove;
    }),
  );
});

const revokeRefreshToken = Effect.fn("revokeRefreshToken")(function* (
  httpClient: HttpClient.HttpClient,
  baseUrl: string,
  refreshToken: string,
) {
  const metadata = yield* discoverOAuth(httpClient, baseUrl);
  const response = yield* executeOAuth(
    httpClient,
    "revocation",
    HttpClientRequest.post(metadata.revocation_endpoint).pipe(
      HttpClientRequest.bodyUrlParams({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: UMAIL_CLI_CLIENT_ID,
      }),
    ),
    REVOCATION_TIMEOUT,
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* failedResponse("revocation", response);
  }
});

const discoverOAuth = Effect.fn("discoverOAuth")(function* (
  httpClient: HttpClient.HttpClient,
  baseUrl: string,
) {
  const metadata = yield* requestJson(
    httpClient,
    "discovery",
    HttpClientRequest.get(
      new URL("/.well-known/oauth-authorization-server/api/auth", `${baseUrl}/`),
    ),
    OAuthMetadata,
  ).pipe(Effect.catchTag("OAuthEndpointError", failed));
  const issuer = `${baseUrl}/api/auth`;
  if (metadata.issuer !== issuer) {
    return yield* new OAuthFailed({
      step: "discovery",
      detail: `issuer is ${metadata.issuer}, expected ${issuer}`,
    });
  }
  for (const endpoint of [
    metadata.device_authorization_endpoint,
    metadata.token_endpoint,
    metadata.revocation_endpoint,
  ]) {
    if (!isSameOriginUrl(endpoint, baseUrl)) {
      return yield* new OAuthFailed({
        step: "discovery",
        detail: `endpoint ${endpoint} is not on ${baseUrl}`,
      });
    }
  }
  return metadata;
});

// Tokens must be bearer tokens that expire and carry the CLI's scopes.
function checkTokens(
  step: OAuthStep,
  tokens: { readonly token_type: string; readonly expires_in: number },
  scope: string,
) {
  if (tokens.token_type.toLowerCase() !== "bearer") {
    return Effect.fail(new OAuthFailed({ step, detail: `token type ${tokens.token_type}` }));
  }
  if (tokens.expires_in <= 0) {
    return Effect.fail(new OAuthFailed({ step, detail: `expires_in ${tokens.expires_in}` }));
  }
  if (!hasRequiredScopes(scope)) {
    return Effect.fail(
      new OAuthFailed({ step, detail: `scope "${scope}" lacks ${REQUIRED_SCOPE}` }),
    );
  }
  return Effect.void;
}

function hasRequiredScopes(scope: string): boolean {
  const scopes = new Set(scope.split(" ").filter((value) => value.length > 0));
  return scopes.has(UMAIL_OAUTH_SCOPE) && scopes.has(OFFLINE_ACCESS_SCOPE);
}

function isSameOriginUrl(value: string, origin: string): boolean {
  return URL.parse(value)?.origin === origin;
}

function isDeviceVerificationUrl(value: string, origin: string): boolean {
  const url = URL.parse(value);
  return url !== null && url.origin === origin && url.pathname === "/device";
}

const pollForTokens = Effect.fn("pollForTokens")(function* (
  httpClient: HttpClient.HttpClient,
  scheduler: OAuthSchedulerService,
  tokenEndpoint: string,
  resource: string,
  device: typeof DeviceCodeResponse.Type,
  startedAt: number,
) {
  // A dropped connection while waiting for the browser is retried a few times before giving up.
  const pollingClient = HttpClient.retryTransient(httpClient, {
    retryOn: "errors-only",
    schedule: Schedule.exponential(POLL_RETRY_BASE),
    times: POLL_TRANSPORT_RETRIES,
  });
  let intervalMs = Math.max(1, device.interval) * 1_000;
  const expiresAt = startedAt + device.expires_in * 1_000;
  while (true) {
    yield* scheduler.sleep(intervalMs);
    const now = yield* scheduler.now;
    if (now >= expiresAt) return yield* new OAuthDeviceCodeExpiredError();
    const response = yield* executeOAuth(
      pollingClient,
      "sign-in approval",
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
      return yield* decodeResponse("sign-in approval", response, OAuthTokenResponse);
    }
    const error = yield* readEndpointError("sign-in approval", response);
    if (error.error === "authorization_pending") continue;
    if (error.error === "slow_down") {
      intervalMs += SLOW_DOWN_INCREMENT_MS;
      continue;
    }
    if (error.error === "access_denied") return yield* new OAuthAccessDeniedError();
    if (error.error === "expired_token") return yield* new OAuthDeviceCodeExpiredError();
    return yield* failed(error);
  }
});

const requestJson = Effect.fn("requestJson")(function* <S extends Schema.Top>(
  httpClient: HttpClient.HttpClient,
  step: OAuthStep,
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) {
  const response = yield* executeOAuth(httpClient, step, request);
  if (response.status < 200 || response.status >= 300) {
    return yield* yield* readEndpointError(step, response);
  }
  return yield* decodeResponse(step, response, schema);
});

function executeOAuth(
  httpClient: HttpClient.HttpClient,
  step: OAuthStep,
  request: HttpClientRequest.HttpClientRequest,
  timeout = OAUTH_HTTP_TIMEOUT,
) {
  return httpClient.execute(request).pipe(
    Effect.catchTag("HttpClientError", (error) => fromHttpClientError(error, step)),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new ServerUnreachable({
            origin: URL.parse(request.url)?.origin ?? request.url,
            step,
            code: `no answer in ${Duration.format(timeout)}`,
          }),
        ),
    }),
  );
}

// An OAuth error body names the refusal; any other failing answer is the server's own failure.
function readEndpointError(step: OAuthStep, response: HttpClientResponse.HttpClientResponse) {
  return HttpClientResponse.schemaBodyJson(OAuthErrorResponse)(response).pipe(
    Effect.map((body) => new OAuthEndpointError({ step, status: response.status, ...body })),
    Effect.mapError(() => new ServerFailed({ status: response.status, step })),
  );
}

function failedResponse(step: OAuthStep, response: HttpClientResponse.HttpClientResponse) {
  return Effect.flatMap(readEndpointError(step, response), failed);
}

function decodeResponse<S extends Schema.Top>(
  step: OAuthStep,
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
) {
  return HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.catchTags({
      SchemaError: (error) =>
        Effect.fail(
          new OAuthFailed({ step, detail: `unexpected response: ${schemaIssueText(error)}` }),
        ),
      HttpClientError: (error) => fromHttpClientError(error, step),
    }),
  );
}

// "HTTP 500 server_error: the database is down"
function failed(error: OAuthEndpointError) {
  const description = error.error_description === undefined ? "" : `: ${error.error_description}`;
  return Effect.fail(
    new OAuthFailed({
      step: error.step,
      detail: `HTTP ${error.status} ${error.error}${description}`,
    }),
  );
}

class OAuthEndpointError extends Data.TaggedError("OAuthEndpointError")<{
  readonly step: OAuthStep;
  readonly status: number;
  readonly error: string;
  readonly error_description?: string;
}> {}
