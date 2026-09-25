import type { BetterAuthInstance, BetterAuthProps } from "@alchemy.run/better-auth";
import type * as Alchemy from "alchemy";
import {
  OFFLINE_ACCESS_SCOPE,
  UMAIL_CLI_CLIENT_ID,
  UMAIL_OAUTH_SCOPE,
  type PrincipalPolicy,
} from "@umail/api-contract";
import { mcp } from "@better-auth/mcp";
import {
  DEVICE_CODE_GRANT_TYPE,
  getOAuthProviderState,
  oauthDeviceAuthorization,
  type ClientDiscovery,
  type OAuthProviderExtension,
  type Scope,
  type SchemaClient,
} from "@better-auth/oauth-provider";
import type { BetterAuthPlugin, GenericEndpointContext, HookEndpointContext } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { MCP_POLICY_MODEL, encodePolicy, policyFromForm } from "./access.ts";
import { DISABLED_AUTH_PATHS } from "./runtime-surface.ts";

const AuthorizeQuery = Schema.Struct({
  client_id: Schema.optionalKey(Schema.String),
  redirect_uri: Schema.optionalKey(Schema.String),
});
const DynamicRegistrationBody = Schema.Struct({
  token_endpoint_auth_method: Schema.String,
  grant_types: Schema.optionalKey(Schema.Array(Schema.String)),
  response_types: Schema.optionalKey(Schema.Array(Schema.String)),
  redirect_uris: Schema.optionalKey(Schema.Array(Schema.String)),
  application_type: Schema.optionalKey(Schema.String),
  resources: Schema.optionalKey(Schema.Array(Schema.String)),
  subject_type: Schema.optionalKey(Schema.String),
  dpop_bound_access_tokens: Schema.optionalKey(Schema.Boolean),
  client_id: Schema.optionalKey(Schema.Never),
  client_secret: Schema.optionalKey(Schema.Never),
  client_id_issued_at: Schema.optionalKey(Schema.Never),
  client_secret_expires_at: Schema.optionalKey(Schema.Never),
  disabled: Schema.optionalKey(Schema.Never),
  user_id: Schema.optionalKey(Schema.Never),
  reference_id: Schema.optionalKey(Schema.Never),
});

type DynamicRegistration = typeof DynamicRegistrationBody.Type;

type NormalizedRegistration = DynamicRegistration & { readonly grant_types: readonly string[] };

const AUTHORIZATION_CODE_GRANT_TYPE = "authorization_code" as const;

const CURSOR_MCP_REDIRECT_URI = "cursor://anysphere.cursor-mcp/oauth/callback" as const;
export const CURSOR_CLOUD_CALLBACK_URI =
  "https://www.cursor.com/agents/mcp/oauth/callback" as const;
const CURSOR_LOOPBACK_CALLBACK_URI = "http://localhost:8787/callback" as const;
const CURSOR_MCP_REDIRECT_URIS: ReadonlySet<string> = new Set([
  CURSOR_MCP_REDIRECT_URI,
  CURSOR_CLOUD_CALLBACK_URI,
  CURSOR_LOOPBACK_CALLBACK_URI,
]);

export const FIRST_PARTY_CLIENT_DISCOVERY_ID = "umail-first-party" as const;

export const CURSOR_GROK_BOT_CLIENT_ID = "cursor-grok-bot" as const;

const FIRST_PARTY_CLIENT_METADATA_JSON = '{"owner":"umail-provision"}' as const;

export type FirstPartyClient = SchemaClient<Scope[]>;

// Clients whose definition lives here. Provisioning writes their rows and links each to its one
// resource; the discovery below makes this definition authoritative at runtime.
export function firstPartyClients(): ReadonlyArray<{
  readonly client: FirstPartyClient;
  readonly resource: "rest" | "mcp";
}> {
  const shared = {
    clientDiscoveryId: FIRST_PARTY_CLIENT_DISCOVERY_ID,
    tokenEndpointAuthMethod: "none",
    scopes: [UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE],
    disabled: false,
    metadata: FIRST_PARTY_CLIENT_METADATA_JSON,
  } satisfies Partial<FirstPartyClient>;
  return [
    {
      resource: "mcp",
      client: {
        ...shared,
        clientId: CURSOR_GROK_BOT_CLIENT_ID,
        name: "Cursor / Grok Bot",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        redirectUris: [CURSOR_CLOUD_CALLBACK_URI],
        requirePKCE: true,
      },
    },
    {
      resource: "rest",
      client: {
        ...shared,
        clientId: UMAIL_CLI_CLIENT_ID,
        name: "AgentMail CLI",
        grantTypes: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
        responseTypes: [],
        redirectUris: [],
        requirePKCE: false,
      },
    },
  ];
}

function firstPartyClientExtension(): OAuthProviderExtension {
  const clients = new Map(firstPartyClients().map(({ client }) => [client.clientId, client]));
  const discovery: ClientDiscovery = {
    id: FIRST_PARTY_CLIENT_DISCOVERY_ID,
    matches: (clientId) => clients.has(clientId),
    resolve: (_ctx, clientId, existing) => {
      const client = clients.get(clientId);
      if (existing === null || client === undefined) return Promise.resolve(null);
      return Promise.resolve({ ...client, disabled: existing.disabled ?? false });
    },
  };
  return { clientDiscovery: [discovery] };
}

// The operator's grant to an MCP client, chosen on the consent screen. Better Auth creates the table,
// and its reference to the consent cascades, so deleting the consent deletes the policy.
function mcpPolicyPlugin(operatorId: string): BetterAuthPlugin {
  const isAcceptedConsent = (ctx: HookEndpointContext) =>
    ctx.path === "/oauth2/consent" && ctx.body?.accept === true;
  return {
    id: "umail-mcp-policy",
    schema: {
      [MCP_POLICY_MODEL]: {
        fields: {
          consentId: {
            type: "string",
            required: true,
            unique: true,
            references: { model: "oauthConsent", field: "id", onDelete: "cascade" },
          },
          policy: { type: "string", required: true },
        },
      },
    },
    hooks: {
      // Rejected before the consent exists, so no consent is left without a policy.
      before: [
        {
          matcher: isAcceptedConsent,
          handler: createAuthMiddleware((ctx) => {
            const policy = policyFromForm(ctx.body);
            return policy.kind === "invalid"
              ? Promise.reject(new APIError("BAD_REQUEST", { message: policy.message }))
              : Promise.resolve();
          }),
        },
      ],
      after: [
        {
          matcher: isAcceptedConsent,
          handler: createAuthMiddleware((ctx) => {
            // Read in the hook's own call: the provider state lives in async-local storage, which a
            // fiber resuming on a later turn may not carry.
            const providerState = getOAuthProviderState();
            const policy = policyFromForm(ctx.body);
            if (isAPIError(ctx.context.returned) || policy.kind === "invalid") {
              return Promise.resolve();
            }
            return Effect.runPromise(
              saveConsentPolicy(ctx.context.adapter, operatorId, providerState, policy.policy),
            );
          }),
        },
      ],
    },
  };
}

// Writes the policy chosen on the consent screen for the consent just granted.
const saveConsentPolicy = Effect.fn("saveConsentPolicy")(function* (
  adapter: HookEndpointContext["context"]["adapter"],
  operatorId: string,
  providerState: ReturnType<typeof getOAuthProviderState>,
  policy: PrincipalPolicy,
) {
  const state = yield* Effect.promise(() => providerState);
  const clientId = new URLSearchParams(state?.query ?? "").get("client_id");
  if (clientId === null) return;
  const consent = yield* Effect.promise(() =>
    adapter.findOne<{ id: string }>({
      model: "oauthConsent",
      where: [
        { field: "clientId", value: clientId },
        { field: "userId", value: operatorId },
      ],
    }),
  );
  if (consent === null) return;
  const existing = yield* Effect.promise(() =>
    adapter.findOne<{ id: string }>({
      model: MCP_POLICY_MODEL,
      where: [{ field: "consentId", value: consent.id }],
    }),
  );
  yield* Effect.promise(() =>
    existing === null
      ? adapter.create({
          model: MCP_POLICY_MODEL,
          data: { consentId: consent.id, policy: encodePolicy(policy) },
        })
      : adapter.update({
          model: MCP_POLICY_MODEL,
          where: [{ field: "id", value: existing.id }],
          update: { policy: encodePolicy(policy) },
        }),
  );
});

type AuthSite = { readonly apiHostname: string };
type AuthRateLimitSetting = { readonly rateLimit: boolean };

export function restResourceUrl(site: AuthSite): string {
  return `https://${site.apiHostname}`;
}

export function mcpResourceUrl(site: AuthSite): string {
  return `${restResourceUrl(site)}/mcp`;
}

export function makeAuthOptions(
  site: AuthSite,
  operatorId: string,
  settings: AuthRateLimitSetting,
) {
  const origin = restResourceUrl(site);
  const mcpResource = mcpResourceUrl(site);
  const rateLimit = settings.rateLimit
    ? ({ enabled: true, storage: "database" } as const)
    : ({ enabled: false } as const);

  return {
    baseURL: origin,
    basePath: "/api/auth",
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { cookieCache: { enabled: false } },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    rateLimit,
    disabledPaths: [...DISABLED_AUTH_PATHS],
    hooks: {
      before: createAuthMiddleware((ctx) =>
        Effect.runPromise(checkClientRequest(ctx, origin, mcpResource)),
      ),
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      mcpPlugin({
        resource: mcpResource,
        extensions: [firstPartyClientExtension()],
        loginPage: "/login",
        consentPage: "/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes: [UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE],
        enforcePerClientResources: true,
        grantTypes: ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE],
        refreshTokenReuseInterval: 30,
        clientPrivileges: ({ user, session }) => user !== undefined && session !== undefined,
        resourcePrivileges: ({ user, session }) => user !== undefined && session !== undefined,
        customAccessTokenClaims: ({ user }) => {
          if (user === undefined || user === null || user.id !== operatorId) {
            throw new APIError("FORBIDDEN", { message: "User is not the AgentMail operator" });
          }
          return { umail_operator: true as const };
        },
      }),
      oauthDevicePlugin({ verificationUri: "/device" }),
      mcpPolicyPlugin(operatorId),
    ],
  } satisfies BetterAuthProps;
}

// Fails with the APIError better-auth answers with when an authorize or register request is not
// admitted; a register request continues with the normalized metadata.
const checkClientRequest = Effect.fn("checkClientRequest")(function* (
  ctx: GenericEndpointContext,
  origin: string,
  mcpResource: string,
) {
  if (ctx.path === "/oauth2/authorize") {
    yield* assertRecognisableRedirectTarget(ctx, origin);
    return undefined;
  }
  if (ctx.path === "/oauth2/register") {
    return yield* Effect.try({
      try: () => normalizedRegistration(ctx, mcpResource),
      catch: (error) => (isAPIError(error) ? error : invalidRegistration()),
    });
  }
  return undefined;
});

// Throws the APIError better-auth answers with when the registration is not admitted.
function normalizedRegistration(ctx: GenericEndpointContext, mcpResource: string) {
  const decoded = Schema.decodeUnknownResult(DynamicRegistrationBody)(ctx.body);
  if (Result.isFailure(decoded)) throw invalidRegistration();
  assertCursorRedirectPolicy(decoded.success);
  const normalized = normalizeDynamicRegistration(decoded.success);
  assertUsableRedirectUris(decoded.success, normalized);
  assertDynamicRegistration(normalized, mcpResource);
  return { context: { body: normalized } };
}

function normalizeDynamicRegistration(registration: DynamicRegistration): NormalizedRegistration {
  const grantTypes = registration.grant_types ?? [AUTHORIZATION_CODE_GRANT_TYPE];
  const resolved = { ...registration, grant_types: grantTypes };
  const filtered =
    registration.redirect_uris === undefined
      ? resolved
      : {
          ...resolved,
          redirect_uris: registration.redirect_uris.filter((uri) =>
            isSupportedRedirectUri(uri, effectiveApplicationType(registration)),
          ),
        };
  if (registration.response_types !== undefined) return filtered;
  if (!grantTypes.includes(AUTHORIZATION_CODE_GRANT_TYPE)) return filtered;
  return { ...filtered, response_types: ["code"] };
}

function effectiveApplicationType(registration: DynamicRegistration): string | undefined {
  if (isCursorMcpPublicClientRegistration(registration)) return "native";
  return registration.application_type;
}

function isCursorMcpPublicClientRegistration(registration: DynamicRegistration): boolean {
  const redirectUris = registration.redirect_uris;
  const grantTypes = registration.grant_types ?? [AUTHORIZATION_CODE_GRANT_TYPE];
  const responseTypes = registration.response_types ?? ["code"];
  const applicationType = registration.application_type;
  if (applicationType !== undefined && applicationType !== "web" && applicationType !== "native") {
    return false;
  }
  return (
    registration.token_endpoint_auth_method === "none" &&
    redirectUris !== undefined &&
    redirectUris.length > 0 &&
    redirectUris.includes(CURSOR_MCP_REDIRECT_URI) &&
    redirectUris.every((redirectUri) => CURSOR_MCP_REDIRECT_URIS.has(redirectUri)) &&
    grantTypes.includes(AUTHORIZATION_CODE_GRANT_TYPE) &&
    grantTypes.every(
      (grantType) => grantType === AUTHORIZATION_CODE_GRANT_TYPE || grantType === "refresh_token",
    ) &&
    responseTypes.length > 0 &&
    responseTypes.every((responseType) => responseType === "code")
  );
}

function assertCursorRedirectPolicy(registration: DynamicRegistration): void {
  const redirectUris = registration.redirect_uris;
  if (redirectUris === undefined || !redirectUris.includes(CURSOR_MCP_REDIRECT_URI)) return;
  if (isCursorMcpPublicClientRegistration(registration)) return;
  throw new APIError("BAD_REQUEST", {
    error: "invalid_redirect_uri",
    error_description: `native private-use redirect URI schemes must be well-formed reverse-domain names, omit the naming authority, and must not use a reserved scheme: ${CURSOR_MCP_REDIRECT_URI}`,
  });
}

function isSupportedRedirectUri(uri: string, applicationType: string | undefined): boolean {
  if (uri === CURSOR_MCP_REDIRECT_URI) return true;
  const parsed = URL.parse(uri);
  if (parsed === null) return false;
  if (applicationType === "native")
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  return parsed.protocol === "https:" && !isLoopbackHost(parsed.hostname);
}

function assertUsableRedirectUris(
  requested: DynamicRegistration,
  normalized: NormalizedRegistration,
): void {
  const offered = requested.redirect_uris;
  if (offered === undefined || offered.length === 0) return;
  if (normalized.redirect_uris !== undefined && normalized.redirect_uris.length > 0) return;
  throw new APIError("BAD_REQUEST", {
    error: "invalid_redirect_uri",
    error_description:
      requested.application_type === "native"
        ? `native clients require http or https redirect URIs: ${offered.join(", ")}`
        : `web clients require https redirect URIs on non-loopback hosts: ${offered.join(", ")}`,
  });
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

// Dynamic registration only admits public authorization-code clients for the MCP resource; the CLI
// is the static `umail-cli` client.
function assertDynamicRegistration(
  registration: NormalizedRegistration,
  mcpResource: string,
): void {
  const grants = new Set(registration.grant_types);
  const responses = registration.response_types;
  const redirects = registration.redirect_uris;
  const resources = registration.resources;
  if (
    registration.token_endpoint_auth_method !== "none" ||
    (registration.subject_type !== undefined && registration.subject_type !== "public") ||
    registration.dpop_bound_access_tokens === true ||
    !grants.has(AUTHORIZATION_CODE_GRANT_TYPE) ||
    grants.size !== (grants.has("refresh_token") ? 2 : 1) ||
    responses === undefined ||
    responses.length !== 1 ||
    responses[0] !== "code" ||
    redirects === undefined ||
    redirects.length === 0 ||
    (resources !== undefined && (resources.length !== 1 || resources[0] !== mcpResource))
  ) {
    throw invalidRegistration();
  }
}

const assertRecognisableRedirectTarget = Effect.fn("assertRecognisableRedirectTarget")(function* (
  ctx: GenericEndpointContext,
  origin: string,
) {
  const decoded = Schema.decodeUnknownResult(AuthorizeQuery)(ctx.query);
  if (Result.isFailure(decoded)) return;
  const { client_id: clientId, redirect_uri: requested } = decoded.success;
  if (clientId === undefined || clientId.length === 0) return;

  const stored = yield* Effect.promise(() =>
    ctx.context.adapter.findOne<SchemaClient<Scope[]>>({
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    }),
  );
  const registered = stored?.redirectUris;
  if (registered === undefined || registered.length === 0) return;

  if (requested === undefined || requested.length === 0) {
    return yield* Effect.fail(
      unregisteredRedirect(
        origin,
        `no redirect_uri was sent; client ${clientId} registered: ${registered.join(", ")}`,
      ),
    );
  }
  if (registered.some((candidate) => couldAddressSameTarget(candidate, requested))) return;
  return yield* Effect.fail(
    unregisteredRedirect(
      origin,
      `redirect_uri ${requested} is not registered for client ${clientId}; registered: ${registered.join(", ")}`,
    ),
  );
});

function unregisteredRedirect(origin: string, description: string): APIError {
  const location = new URL(`${origin}/api/auth/error`);
  location.searchParams.set("error", "invalid_redirect");
  location.searchParams.set("error_description", description);
  return new APIError("FOUND", {}, { Location: location.toString() });
}

function couldAddressSameTarget(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const left = URL.parse(registered);
  const right = URL.parse(requested);
  if (left === null || right === null) return false;
  if (left.protocol !== right.protocol || left.pathname !== right.pathname) return false;
  return (
    left.hostname === right.hostname ||
    (isLoopbackHost(left.hostname) && isLoopbackHost(right.hostname))
  );
}

function invalidRegistration(): APIError {
  return new APIError("BAD_REQUEST", { message: "Unsupported public OAuth client metadata" });
}

function mcpPlugin(options: Parameters<typeof mcp>[0]): ReturnType<typeof mcp> & BetterAuthPlugin {
  const plugin = mcp(options);
  return plugin as ReturnType<typeof mcp> & BetterAuthPlugin;
}

function oauthDevicePlugin(
  options: Parameters<typeof oauthDeviceAuthorization>[0],
): ReturnType<typeof oauthDeviceAuthorization> & BetterAuthPlugin {
  const plugin = oauthDeviceAuthorization(options);
  return plugin as ReturnType<typeof oauthDeviceAuthorization> & BetterAuthPlugin;
}

type DeferredUmailAuth = BetterAuthInstance<ReturnType<typeof makeAuthOptions>>;
type UmailAuth = Effect.Success<DeferredUmailAuth["auth"]>;

type RequiredUmailAuthApiMethod =
  | "getJwks"
  | "getSession"
  | "signOut"
  | "deviceVerify"
  | "deviceApprove"
  | "deviceDeny";

// Better Auth types plugin endpoints as optional; these plugins are always configured.
type RequiredUmailAuthApi = UmailAuth["api"] & {
  readonly [K in RequiredUmailAuthApiMethod]-?: NonNullable<UmailAuth["api"][K]>;
};

export type UmailBetterAuth = Omit<
  Pick<UmailAuth, "handler" | "api" | "options" | "$context">,
  "api"
> & { readonly api: RequiredUmailAuthApi };

export function asUmailBetterAuth<T>(auth: T): UmailBetterAuth {
  return auth as T & UmailBetterAuth;
}

// The per-request Better Auth instance alchemy provides. Its own typed API is used, not alchemy's
// effectified `api`, whose types degrade to `(any) => Effect<any>` for this plugin set.
export type UmailAuthInstance = {
  readonly auth: Effect.Effect<UmailBetterAuth, never, Alchemy.RuntimeContext>;
};
