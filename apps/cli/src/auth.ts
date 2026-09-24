import { configFromEnvironment, type UmailClientEnvironment } from "@umail/api-contract/client";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  OAuthCredentialStore,
  OAuthCredentialSupersededError,
  type OAuthAuthorizedState,
  type OAuthCredentialState,
  type OAuthCredentialStoreService,
  type OAuthLogoutRevocation,
  type OAuthRegisteredState,
  registeredCredentialState,
} from "./credential-store.ts";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code" as const;
const REFRESH_GRANT = "refresh_token" as const;
const UMAIL_SCOPE = "umail:access" as const;
const OFFLINE_SCOPE = "offline_access" as const;
const REQUIRED_SCOPE = `${UMAIL_SCOPE} ${OFFLINE_SCOPE}` as const;
const REFRESH_SKEW_MS = 30_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
const OAUTH_HTTP_TIMEOUT = Duration.seconds(5);
const REVOCATION_TIMEOUT = Duration.seconds(3);

const OAuthMetadata = Schema.Struct({
  issuer: Schema.String,
  registration_endpoint: Schema.String,
  device_authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  revocation_endpoint: Schema.String,
});

const DynamicClientResponse = Schema.Struct({
  client_id: Schema.String,
  token_endpoint_auth_method: Schema.Literal("none"),
  client_secret: Schema.optionalKey(Schema.Never),
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

export class OAuthLoginRequiredError extends Data.TaggedError("OAuthLoginRequiredError") {
  override readonly message = "OAuth login required. Run: umail login";
}
export class OAuthProtocolError extends Data.TaggedError("OAuthProtocolError") {
  override readonly message = "The OAuth server returned an invalid response.";
}
export class OAuthAccessDeniedError extends Data.TaggedError("OAuthAccessDeniedError") {
  override readonly message = "Device authorization was denied.";
}
export class OAuthDeviceCodeExpiredError extends Data.TaggedError("OAuthDeviceCodeExpiredError") {
  override readonly message = "The device authorization code expired. Run: umail login";
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

export function login(env: UmailClientEnvironment) {
  return Effect.gen(function* () {
    const config = yield* configFromEnvironment(env);
    const httpClient = yield* HttpClient.HttpClient;
    const store = yield* OAuthCredentialStore;
    const scheduler = yield* OAuthScheduler;
    const metadata = yield* discoverOAuth(httpClient, config.baseUrl);
    const existing = yield* store.read;
    const reusable = validRegistration(existing, config.baseUrl, metadata.issuer);
    const registration =
      reusable ?? (yield* registerClient(httpClient, store, metadata, config.baseUrl));
    const attempt = loginWithRegistration(httpClient, store, scheduler, metadata, registration);
    if (reusable === null) return yield* attempt;
    return yield* attempt.pipe(
      Effect.catchTag("OAuthEndpointError", (error) =>
        error.error === "invalid_client"
          ? Effect.gen(function* () {
              const replacement = yield* registerClient(
                httpClient,
                store,
                metadata,
                config.baseUrl,
              );
              return yield* loginWithRegistration(
                httpClient,
                store,
                scheduler,
                metadata,
                replacement,
              );
            })
          : Effect.fail(error),
      ),
    );
  }).pipe(Effect.catchTag("OAuthEndpointError", () => new OAuthProtocolError()));
}

function loginWithRegistration(
  httpClient: HttpClient.HttpClient,
  store: OAuthCredentialStoreService,
  scheduler: OAuthSchedulerService,
  metadata: typeof OAuthMetadata.Type,
  registration: OAuthRegisteredState,
) {
  return Effect.gen(function* () {
    const device = yield* requestJson(
      httpClient,
      HttpClientRequest.post(metadata.device_authorization_endpoint).pipe(
        HttpClientRequest.bodyUrlParams({
          client_id: registration.clientId,
          resource: registration.resource,
          scope: registration.scope,
        }),
      ),
      DeviceCodeResponse,
    );
    if (
      device.expires_in <= 0 ||
      device.interval <= 0 ||
      !isDeviceVerificationUrl(device.verification_uri, registration.origin) ||
      !isDeviceVerificationUrl(device.verification_uri_complete, registration.origin)
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
      registration,
      device,
      startedAt,
    );
    const now = yield* scheduler.now;
    const refreshToken = tokens.refresh_token;
    if (
      tokens.token_type.toLowerCase() !== "bearer" ||
      tokens.expires_in <= 0 ||
      !hasRequiredScopes(tokens.scope ?? registration.scope) ||
      refreshToken === undefined ||
      refreshToken.length === 0
    ) {
      return yield* new OAuthProtocolError();
    }
    const authorized = {
      ...registration,
      kind: "authorized",
      scope: tokens.scope ?? registration.scope,
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt: now + tokens.expires_in * 1_000,
      generation: registration.generation,
    } as const satisfies OAuthAuthorizedState;
    const outcome = yield* store.commit(registration.generation, authorized);
    if (outcome === "superseded") return yield* new OAuthCredentialSupersededError();
  });
}

function registerClient(
  httpClient: HttpClient.HttpClient,
  store: OAuthCredentialStoreService,
  metadata: typeof OAuthMetadata.Type,
  origin: string,
) {
  return Effect.gen(function* () {
    const current = yield* store.read;
    const generation = current?.generation ?? 0;
    const request = HttpClientRequest.post(metadata.registration_endpoint).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        client_name: "AgentMail CLI",
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: [DEVICE_GRANT, REFRESH_GRANT],
        subject_type: "public",
        dpop_bound_access_tokens: false,
        resources: [origin],
      }),
    );
    const response = yield* requestJson(httpClient, request, DynamicClientResponse);
    if (response.client_id.length === 0) return yield* new OAuthProtocolError();
    const registration = {
      version: 2,
      kind: "registered",
      origin,
      issuer: metadata.issuer,
      resource: origin,
      scope: REQUIRED_SCOPE,
      clientId: response.client_id,
      generation,
    } as const satisfies OAuthRegisteredState;
    const outcome = yield* store.commit(generation, registration);
    if (outcome === "superseded") return yield* new OAuthCredentialSupersededError();
    return registration;
  });
}

export function accessToken(env: UmailClientEnvironment) {
  return Effect.gen(function* () {
    const config = yield* configFromEnvironment(env);
    const store = yield* OAuthCredentialStore;
    const scheduler = yield* OAuthScheduler;
    return yield* store.withRefreshLock(
      Effect.gen(function* () {
        const state = yield* store.read;
        if (state === null || state.origin !== config.baseUrl || state.kind !== "authorized") {
          return yield* new OAuthLoginRequiredError();
        }
        if (!validRegistration(state, config.baseUrl, `${config.baseUrl}/api/auth`)) {
          return yield* new OAuthProtocolError();
        }
        const now = yield* scheduler.now;
        if (state.expiresAt - now > REFRESH_SKEW_MS) return Redacted.make(state.accessToken);
        const httpClient = yield* HttpClient.HttpClient;
        const metadata = yield* discoverOAuth(httpClient, config.baseUrl);
        const refreshed = yield* requestJson(
          httpClient,
          HttpClientRequest.post(metadata.token_endpoint).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: REFRESH_GRANT,
              refresh_token: state.refreshToken,
              client_id: state.clientId,
              resource: state.resource,
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
        if (
          refreshed.token_type.toLowerCase() !== "bearer" ||
          refreshed.expires_in <= 0 ||
          !hasRequiredScopes(refreshed.scope ?? state.scope)
        )
          return yield* new OAuthProtocolError();
        const nextState = {
          ...state,
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? state.refreshToken,
          scope: refreshed.scope ?? state.scope,
          expiresAt: now + refreshed.expires_in * 1_000,
          generation: state.generation,
        } satisfies OAuthAuthorizedState;
        const outcome = yield* store.commit(state.generation, nextState);
        if (outcome === "superseded") return yield* new OAuthLoginRequiredError();
        return Redacted.make(nextState.accessToken);
      }),
    );
  });
}

export function logout(env: UmailClientEnvironment) {
  return Effect.gen(function* () {
    const config = yield* configFromEnvironment(env);
    const store = yield* OAuthCredentialStore;
    const revocation = yield* store.takeLogoutSnapshot(config.baseUrl);
    if (revocation === null) return;
    const httpClient = yield* HttpClient.HttpClient;
    const remote = revokeRefreshToken(httpClient, config.baseUrl, revocation);
    const remoteResult = yield* Effect.result(remote);
    if (Result.isFailure(remoteResult)) {
      yield* Console.error("Local OAuth tokens removed; remote revocation could not be confirmed.");
    }
  });
}

function revokeRefreshToken(
  httpClient: HttpClient.HttpClient,
  baseUrl: string,
  revocation: OAuthLogoutRevocation,
) {
  return Effect.gen(function* () {
    const metadata = yield* discoverOAuth(httpClient, baseUrl);
    const response = yield* httpClient.execute(
      HttpClientRequest.post(metadata.revocation_endpoint).pipe(
        HttpClientRequest.bodyUrlParams({
          token: revocation.refreshToken,
          token_type_hint: "refresh_token",
          client_id: revocation.clientId,
        }),
      ),
    );
    yield* response.arrayBuffer.pipe(Effect.asVoid, Effect.ignore);
    if (response.status < 200 || response.status >= 300) return yield* new OAuthProtocolError();
  }).pipe(
    Effect.timeout(REVOCATION_TIMEOUT),
    Effect.catchTag("TimeoutError", () => new OAuthProtocolError()),
  );
}

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
        isSameOriginUrl(metadata.registration_endpoint, baseUrl) &&
        isSameOriginUrl(metadata.device_authorization_endpoint, baseUrl) &&
        isSameOriginUrl(metadata.token_endpoint, baseUrl) &&
        isSameOriginUrl(metadata.revocation_endpoint, baseUrl),
      () => new OAuthProtocolError(),
    ),
  );
}

function validRegistration(
  state: OAuthCredentialState | null,
  origin: string,
  issuer: string,
): OAuthRegisteredState | null {
  if (
    state === null ||
    state.origin !== origin ||
    state.issuer !== issuer ||
    state.resource !== origin ||
    state.clientId.length === 0 ||
    !hasRequiredScopes(state.scope)
  )
    return null;
  return registeredCredentialState(state);
}

function hasRequiredScopes(scope: string): boolean {
  const scopes = new Set(scope.split(" ").filter((value) => value.length > 0));
  return scopes.has(UMAIL_SCOPE) && scopes.has(OFFLINE_SCOPE);
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

function pollForTokens(
  httpClient: HttpClient.HttpClient,
  scheduler: OAuthSchedulerService,
  tokenEndpoint: string,
  registration: OAuthRegisteredState,
  device: typeof DeviceCodeResponse.Type,
  startedAt: number,
) {
  return Effect.gen(function* () {
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
            client_id: registration.clientId,
            resource: registration.resource,
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
}

function requestJson<S extends Schema.Top>(
  httpClient: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) {
  return Effect.gen(function* () {
    const response = yield* executeOAuth(httpClient, request);
    if (response.status < 200 || response.status >= 300) {
      const error = yield* decodeResponse(response, OAuthErrorResponse);
      return yield* new OAuthEndpointError({ error: error.error });
    }
    return yield* decodeResponse(response, schema);
  });
}

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
