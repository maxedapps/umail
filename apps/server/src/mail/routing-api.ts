import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export const emailRoutingDomainStatuses = [
  "ready",
  "unconfigured",
  "misconfigured",
  "misconfigured/locked",
  "unlocked",
] as const;

export type EmailRoutingDomainStatus = (typeof emailRoutingDomainStatuses)[number];

export interface EmailRoutingDomainIdentity {
  readonly zoneId: string;
  readonly name: string;
}

export interface EmailRoutingDomainRegistration extends EmailRoutingDomainIdentity {
  readonly subdomainId: string;
  readonly enabled: boolean;
  readonly status: EmailRoutingDomainStatus;
  readonly dnsReady: boolean;
}

export interface EmailRoutingDomainInspection {
  readonly zoneName: string;
  readonly apexEnabled: boolean;
  readonly enabledNames: ReadonlyArray<string>;
  readonly exact: EmailRoutingDomainRegistration | undefined;
}

export type EmailRoutingDomainApiOperation =
  | "read-routing-settings"
  | "read-dns-requirements"
  | "enable-routing-domain"
  | "disable-routing-domain";

export const emailRoutingDomainApiFailureReasons = [
  "invalid-base-url",
  "credential-resolution-failed",
  "transport-failed",
  "invalid-error-response",
  "cloudflare-rejected-request",
  "invalid-success-response",
  "duplicate-registration",
  "request-encoding-failed",
] as const;

export type EmailRoutingDomainApiFailureReason =
  (typeof emailRoutingDomainApiFailureReasons)[number];

export class EmailRoutingDomainApiError extends Data.TaggedError("EmailRoutingDomainApiError")<{
  readonly operation: EmailRoutingDomainApiOperation;
  readonly status: number;
  readonly message: string;
  readonly reason: EmailRoutingDomainApiFailureReason;
}> {}

export interface EmailRoutingDomainsApiService {
  inspect(
    identity: EmailRoutingDomainIdentity,
  ): Effect.Effect<EmailRoutingDomainInspection, EmailRoutingDomainApiError>;
  enableApex(identity: EmailRoutingDomainIdentity): Effect.Effect<void, EmailRoutingDomainApiError>;
  enable(identity: EmailRoutingDomainIdentity): Effect.Effect<void, EmailRoutingDomainApiError>;
  disableExact(
    identity: EmailRoutingDomainIdentity,
  ): Effect.Effect<void, EmailRoutingDomainApiError>;
}

export class EmailRoutingDomainsApi extends Context.Service<
  EmailRoutingDomainsApi,
  EmailRoutingDomainsApiService
>()("uMail/EmailRoutingDomainsApi") {}

const RoutingStatus = Schema.Literals(emailRoutingDomainStatuses);

const RoutingSubdomain = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  status: RoutingStatus,
});

const RoutingSettingsSuccess = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    enabled: Schema.Boolean,
    status: RoutingStatus,
    subdomains: Schema.optionalKey(Schema.Array(RoutingSubdomain)),
  }),
});

const DnsRequirementError = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
});

// The default endpoint lists required records. It does not report whether
// those records are present; apex readiness comes from routing settings.
const ApexDnsRequirementsSuccess = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        content: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
        priority: Schema.optionalKey(Schema.Finite),
        ttl: Schema.optionalKey(Schema.Finite),
        type: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

// Compatibility response for Cloudflare's deprecated subdomain query.
const DnsRequirementsSuccess = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    errors: Schema.NullOr(Schema.Array(DnsRequirementError)),
  }),
});

const MutationSuccess = Schema.Struct({
  success: Schema.Literal(true),
});

const CloudflareApiFailure = Schema.Struct({
  success: Schema.Literal(false),
  errors: Schema.Array(
    Schema.Struct({
      code: Schema.Finite,
      message: Schema.String,
    }),
  ),
});

const RoutingDomainMutation = Schema.Struct({
  name: Schema.String,
});

type DeploymentCredentialsResolver = Effect.Success<typeof Cloudflare.Credentials>;
type DeploymentCredentials = Effect.Success<DeploymentCredentialsResolver>;

interface LiveEmailRoutingDomainApiContext {
  readonly http: HttpClient.HttpClient;
  readonly resolveCredentials: DeploymentCredentialsResolver;
}

function apiError(
  operation: EmailRoutingDomainApiOperation,
  status: number,
  message: string,
  reason: EmailRoutingDomainApiFailureReason,
) {
  return new EmailRoutingDomainApiError({ operation, status, message, reason });
}

function routingUrl(
  credentials: DeploymentCredentials,
  identity: EmailRoutingDomainIdentity,
  operation: EmailRoutingDomainApiOperation,
) {
  return Effect.try({
    try: () => {
      const baseUrl = credentials.apiBaseUrl.endsWith("/")
        ? credentials.apiBaseUrl
        : `${credentials.apiBaseUrl}/`;
      return new URL(`zones/${encodeURIComponent(identity.zoneId)}/email/routing`, baseUrl);
    },
    catch: () => apiError(operation, 0, "Cloudflare API base URL is invalid.", "invalid-base-url"),
  });
}

function authorize(
  request: HttpClientRequest.HttpClientRequest,
  credentials: DeploymentCredentials,
) {
  switch (credentials.type) {
    case "apiKey":
      return request.pipe(
        HttpClientRequest.setHeader("x-auth-key", Redacted.value(credentials.apiKey)),
        HttpClientRequest.setHeader("x-auth-email", credentials.email),
      );
    case "apiToken":
      return request.pipe(HttpClientRequest.bearerToken(Redacted.value(credentials.apiToken)));
    case "oauth":
      return request.pipe(HttpClientRequest.bearerToken(Redacted.value(credentials.accessToken)));
  }
}

function failureMessage(failure: typeof CloudflareApiFailure.Type) {
  return failure.errors[0]?.message ?? "Cloudflare rejected the Email Routing request.";
}

function executeSuccess<S extends Schema.Constraint>(
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
  operation: EmailRoutingDomainApiOperation,
): Effect.Effect<S["Type"], EmailRoutingDomainApiError, S["DecodingServices"]> {
  return Effect.gen(function* () {
    const response = yield* http
      .execute(request)
      .pipe(
        Effect.mapError(() =>
          apiError(operation, 0, "Cloudflare Email Routing request failed.", "transport-failed"),
        ),
      );
    const text = yield* response.text.pipe(
      Effect.mapError(() =>
        apiError(
          operation,
          response.status,
          "Cloudflare returned an invalid Email Routing response.",
          "invalid-success-response",
        ),
      ),
    );
    const failure = Schema.decodeResult(Schema.fromJsonString(CloudflareApiFailure))(text);
    if (Result.isSuccess(failure)) {
      return yield* apiError(
        operation,
        response.status,
        failureMessage(failure.success),
        "cloudflare-rejected-request",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* apiError(
        operation,
        response.status,
        "Cloudflare returned an invalid Email Routing error response.",
        "invalid-error-response",
      );
    }
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(() =>
        apiError(
          operation,
          response.status,
          "Cloudflare returned an invalid Email Routing response.",
          "invalid-success-response",
        ),
      ),
    );
  });
}

function exactSubdomain(
  settings: typeof RoutingSettingsSuccess.Type,
  identity: EmailRoutingDomainIdentity,
) {
  const matches = (settings.result.subdomains ?? []).filter(
    (subdomain) => subdomain.name === identity.name,
  );
  if (matches.length > 1) {
    return Effect.fail(
      apiError(
        "read-routing-settings",
        200,
        `Cloudflare returned duplicate Email Routing registrations for ${identity.name}.`,
        "duplicate-registration",
      ),
    );
  }
  return Effect.succeed(matches[0]);
}

function readRoutingSettings(
  context: LiveEmailRoutingDomainApiContext,
  identity: EmailRoutingDomainIdentity,
) {
  return Effect.gen(function* () {
    const credentials = yield* context.resolveCredentials.pipe(
      Effect.mapError(() =>
        apiError(
          "read-routing-settings",
          0,
          "Could not resolve Cloudflare deployment credentials.",
          "credential-resolution-failed",
        ),
      ),
    );
    const url = yield* routingUrl(credentials, identity, "read-routing-settings");
    const request = authorize(
      HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson),
      credentials,
    );
    return yield* executeSuccess(
      context.http,
      request,
      RoutingSettingsSuccess,
      "read-routing-settings",
    );
  });
}

function readDnsReadiness(
  context: LiveEmailRoutingDomainApiContext,
  identity: EmailRoutingDomainIdentity,
  subdomain: string | undefined,
) {
  return Effect.gen(function* () {
    const credentials = yield* context.resolveCredentials.pipe(
      Effect.mapError(() =>
        apiError(
          "read-dns-requirements",
          0,
          "Could not resolve Cloudflare deployment credentials.",
          "credential-resolution-failed",
        ),
      ),
    );
    const url = yield* routingUrl(credentials, identity, "read-dns-requirements");
    url.pathname = `${url.pathname}/dns`;
    if (subdomain !== undefined) {
      url.searchParams.set("subdomain", subdomain);
    }
    const request = authorize(
      HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson),
      credentials,
    );
    if (subdomain === undefined) {
      yield* executeSuccess(
        context.http,
        request,
        ApexDnsRequirementsSuccess,
        "read-dns-requirements",
      );
      return undefined;
    }
    const response = yield* executeSuccess(
      context.http,
      request,
      DnsRequirementsSuccess,
      "read-dns-requirements",
    );
    return response.result.errors === null || response.result.errors.length === 0;
  });
}

function enableApexRouting(
  context: LiveEmailRoutingDomainApiContext,
  identity: EmailRoutingDomainIdentity,
) {
  return Effect.gen(function* () {
    const credentials = yield* context.resolveCredentials.pipe(
      Effect.mapError(() =>
        apiError(
          "enable-routing-domain",
          0,
          "Could not resolve Cloudflare deployment credentials.",
          "credential-resolution-failed",
        ),
      ),
    );
    const url = yield* routingUrl(credentials, identity, "enable-routing-domain");
    url.pathname = `${url.pathname}/dns`;
    const request = authorize(
      HttpClientRequest.post(url).pipe(HttpClientRequest.acceptJson),
      credentials,
    );
    yield* executeSuccess(context.http, request, MutationSuccess, "enable-routing-domain");
  });
}

function enableRoutingDomain(
  context: LiveEmailRoutingDomainApiContext,
  identity: EmailRoutingDomainIdentity,
) {
  return Effect.gen(function* () {
    const credentials = yield* context.resolveCredentials.pipe(
      Effect.mapError(() =>
        apiError(
          "enable-routing-domain",
          0,
          "Could not resolve Cloudflare deployment credentials.",
          "credential-resolution-failed",
        ),
      ),
    );
    const url = yield* routingUrl(credentials, identity, "enable-routing-domain");
    url.pathname = `${url.pathname}/dns`;
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.schemaBodyJson(RoutingDomainMutation)({ name: identity.name }),
      Effect.map((request) => authorize(request, credentials)),
      Effect.mapError(() =>
        apiError(
          "enable-routing-domain",
          0,
          "Could not encode the Email Routing domain request.",
          "request-encoding-failed",
        ),
      ),
    );
    yield* executeSuccess(context.http, request, MutationSuccess, "enable-routing-domain");
  });
}

function disableExactRoutingDomain(
  context: LiveEmailRoutingDomainApiContext,
  identity: EmailRoutingDomainIdentity,
) {
  return Effect.gen(function* () {
    const credentials = yield* context.resolveCredentials.pipe(
      Effect.mapError(() =>
        apiError(
          "disable-routing-domain",
          0,
          "Could not resolve Cloudflare deployment credentials.",
          "credential-resolution-failed",
        ),
      ),
    );
    const url = yield* routingUrl(credentials, identity, "disable-routing-domain");
    url.pathname = `${url.pathname}/disable`;
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.schemaBodyJson(RoutingDomainMutation)({ name: identity.name }),
      Effect.map((request) => authorize(request, credentials)),
      Effect.mapError(() =>
        apiError(
          "disable-routing-domain",
          0,
          "Could not encode the Email Routing domain request.",
          "request-encoding-failed",
        ),
      ),
    );
    yield* executeSuccess(context.http, request, MutationSuccess, "disable-routing-domain");
  });
}

function enabledChildNames(settings: typeof RoutingSettingsSuccess.Type) {
  return (settings.result.subdomains ?? [])
    .filter((entry) => entry.enabled)
    .map((entry) => entry.name);
}

function makeLiveEmailRoutingDomainsApi(
  context: LiveEmailRoutingDomainApiContext,
): EmailRoutingDomainsApiService {
  return {
    inspect: (identity) =>
      Effect.gen(function* () {
        const settings = yield* readRoutingSettings(context, identity);
        const zoneName = settings.result.name;
        if (identity.name === zoneName) {
          const dnsReady = settings.result.enabled && settings.result.status === "ready";
          if (dnsReady) {
            yield* readDnsReadiness(context, identity, undefined);
          }
          return {
            zoneName,
            apexEnabled: settings.result.enabled,
            enabledNames: enabledChildNames(settings),
            exact: {
              subdomainId: settings.result.id,
              zoneId: identity.zoneId,
              name: settings.result.name,
              enabled: settings.result.enabled,
              status: settings.result.status,
              dnsReady,
            },
          } satisfies EmailRoutingDomainInspection;
        }
        const subdomain = yield* exactSubdomain(settings, identity);
        const dnsReady =
          settings.result.enabled && subdomain?.enabled === true && subdomain.status === "ready"
            ? (yield* readDnsReadiness(context, identity, identity.name)) === true
            : false;
        const exact =
          subdomain === undefined
            ? undefined
            : ({
                subdomainId: subdomain.id,
                zoneId: identity.zoneId,
                name: subdomain.name,
                enabled: subdomain.enabled,
                status: subdomain.status,
                dnsReady,
              } satisfies EmailRoutingDomainRegistration);
        return {
          zoneName,
          apexEnabled: settings.result.enabled,
          enabledNames: enabledChildNames(settings),
          exact,
        } satisfies EmailRoutingDomainInspection;
      }),
    enableApex: (identity) => enableApexRouting(context, identity),
    enable: (identity) => enableRoutingDomain(context, identity),
    disableExact: (identity) => disableExactRoutingDomain(context, identity),
  };
}

export const EmailRoutingDomainsApiLive = Layer.effect(
  EmailRoutingDomainsApi,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const resolveCredentials = yield* Cloudflare.Credentials;
    return makeLiveEmailRoutingDomainsApi({ http, resolveCredentials });
  }),
);
