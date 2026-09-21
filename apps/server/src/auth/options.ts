import type { BetterAuthInstance, BetterAuthProps } from "@alchemy.run/better-auth";
import { mcp } from "@better-auth/mcp";
import {
  DEVICE_CODE_GRANT_TYPE,
  oauthDeviceAuthorization,
  type ClientDiscovery,
  type OAuthProviderExtension,
  type Scope,
  type SchemaClient,
} from "@better-auth/oauth-provider";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import type * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

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

export const UMAIL_OAUTH_SCOPE = "umail:access" as const;
export const OFFLINE_ACCESS_SCOPE = "offline_access" as const;

export const FIRST_PARTY_CLIENT_DISCOVERY_ID = "umail-first-party" as const;

export const CURSOR_GROK_BOT_CLIENT_ID = "cursor-grok-bot" as const;

export const FIRST_PARTY_CLIENT_METADATA_JSON = '{"owner":"umail-provision"}' as const;

type FirstPartyClient = SchemaClient<Scope[]>;

export function cursorGrokBotClient(): FirstPartyClient {
  return {
    clientId: CURSOR_GROK_BOT_CLIENT_ID,
    clientDiscoveryId: FIRST_PARTY_CLIENT_DISCOVERY_ID,
    name: "Cursor / Grok Bot",
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    redirectUris: [CURSOR_CLOUD_CALLBACK_URI],
    scopes: [UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE],
    requirePKCE: true,
    disabled: false,
    metadata: FIRST_PARTY_CLIENT_METADATA_JSON,
  };
}

export function firstPartyClientExtension(): OAuthProviderExtension {
  const discovery: ClientDiscovery = {
    id: FIRST_PARTY_CLIENT_DISCOVERY_ID,
    matches: (clientId) => clientId === CURSOR_GROK_BOT_CLIENT_ID,
    resolve: async (_ctx, _clientId, existing) => {
      if (existing === null) return null;
      const client = cursorGrokBotClient();
      return { ...client, disabled: existing.disabled ?? false };
    },
  };
  return { clientDiscovery: [discovery] };
}

export type AuthSite = { readonly apiHostname: string };
export type AuthRateLimitSetting = { readonly rateLimit: boolean };

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
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/oauth2/authorize") {
          await assertRecognisableRedirectTarget(ctx, origin);
          return;
        }
        if (ctx.path === "/oauth2/register") {
          const decoded = Schema.decodeUnknownResult(DynamicRegistrationBody)(ctx.body);
          if (Result.isFailure(decoded)) throw invalidRegistration();
          assertCursorRedirectPolicy(decoded.success);
          const normalized = normalizeDynamicRegistration(decoded.success);
          assertUsableRedirectUris(decoded.success, normalized);
          assertDynamicRegistration(normalized, origin, mcpResource);
          return { context: { body: normalized } };
        }
      }),
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
        clientRegistrationAllowedResources: [origin],
        scopes: [UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE],
        resources: [
          {
            identifier: origin,
            accessTokenTtl: 300,
            allowedScopes: [UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE],
          },
          {
            identifier: mcpResource,
            accessTokenTtl: 300,
            allowedScopes: [UMAIL_OAUTH_SCOPE, OFFLINE_ACCESS_SCOPE],
          },
        ],
        resourceSeedMode: "insertOnly",
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
    ],
  } satisfies BetterAuthProps;
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

function assertDynamicRegistration(
  registration: NormalizedRegistration,
  origin: string,
  mcpResource: string,
): void {
  if (
    registration.token_endpoint_auth_method !== "none" ||
    (registration.subject_type !== undefined && registration.subject_type !== "public") ||
    registration.dpop_bound_access_tokens === true
  ) {
    throw invalidRegistration();
  }

  const grants = new Set(registration.grant_types);
  const hasRefresh = grants.has("refresh_token");
  if (grants.size !== (hasRefresh ? 2 : 1)) throw invalidRegistration();

  if (grants.has("authorization_code")) {
    const responses = registration.response_types;
    const redirects = registration.redirect_uris;
    const resources = registration.resources;
    if (
      responses === undefined ||
      responses.length !== 1 ||
      responses[0] !== "code" ||
      redirects === undefined ||
      redirects.length === 0 ||
      (resources !== undefined && (resources.length !== 1 || resources[0] !== mcpResource))
    ) {
      throw invalidRegistration();
    }
    return;
  }

  if (
    !grants.has(DEVICE_CODE_GRANT_TYPE) ||
    registration.application_type !== "native" ||
    registration.response_types !== undefined ||
    registration.redirect_uris !== undefined ||
    registration.resources?.length !== 1 ||
    registration.resources[0] !== origin
  ) {
    throw invalidRegistration();
  }
}

async function assertRecognisableRedirectTarget(
  ctx: GenericEndpointContext,
  origin: string,
): Promise<void> {
  const decoded = Schema.decodeUnknownResult(AuthorizeQuery)(ctx.query);
  if (Result.isFailure(decoded)) return;
  const { client_id: clientId, redirect_uri: requested } = decoded.success;
  if (clientId === undefined || clientId.length === 0) return;

  const stored = await ctx.context.adapter.findOne<SchemaClient<Scope[]>>({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  const registered = stored?.redirectUris;
  if (registered === undefined || registered.length === 0) return;

  if (requested === undefined || requested.length === 0) {
    throw unregisteredRedirect(
      origin,
      `no redirect_uri was sent; client ${clientId} registered: ${registered.join(", ")}`,
    );
  }
  if (registered.some((candidate) => couldAddressSameTarget(candidate, requested))) return;
  throw unregisteredRedirect(
    origin,
    `redirect_uri ${requested} is not registered for client ${clientId}; registered: ${registered.join(", ")}`,
  );
}

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
export type UmailAuth = Effect.Success<DeferredUmailAuth["auth"]>;

type RequiredUmailAuthApiMethod =
  | "getJwks"
  | "getSession"
  | "deviceVerify"
  | "deviceApprove"
  | "deviceDeny";

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
