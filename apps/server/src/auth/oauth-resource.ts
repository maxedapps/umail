import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import {
  createInsufficientScopeError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
} from "better-auth/oauth2";
import type * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UmailAuthInstance } from "./options.ts";

const OAuthAccessTokenClaims = Schema.Struct({
  sub: Schema.String.check(Schema.isMinLength(1)),
  client_id: Schema.String.check(Schema.isMinLength(1)),
  scope: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  umail_operator: Schema.Literal(true),
});

// Module-level so the JWKS cache outlives the per-request auth instance. better-auth caches the
// resolved key set with a TTL and refetches when a token's kid is missing.
const JWKS_CACHE_KEY = {};

export type OAuthAccess = {
  readonly subject: string;
  readonly clientId: string;
  readonly scopes: ReadonlySet<string>;
};

type OAuthResourceRequirements = {
  readonly issuer: string;
  readonly audience: string;
  readonly scopes: ReadonlyArray<string>;
};

export const verifyOAuthResourceRequest = Effect.fn("verifyOAuthResourceRequest")(function* (
  auth: UmailAuthInstance,
  request: Request,
  requirements: OAuthResourceRequirements,
) {
  const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
  if (authorization === undefined || authorization.scheme !== "Bearer") {
    return yield* Effect.fail(unauthorizedAccessToken());
  }
  return yield* verifyOAuthBearerToken(auth, authorization.token, requirements);
});

export const verifyOAuthBearerToken = Effect.fn("verifyOAuthBearerToken")(function* (
  auth: UmailAuthInstance,
  token: string,
  requirements: OAuthResourceRequirements,
) {
  // better-auth fetches the key set through a Promise callback, run in this request's context.
  const run = Effect.runPromiseWith(yield* Effect.context<Alchemy.RuntimeContext>());
  const payload = yield* Effect.tryPromise({
    try: () =>
      verifyJwsAccessToken(token, {
        jwksFetch: () => run(auth.auth).then((instance) => instance.api.getJwks({})),
        jwksCacheKey: JWKS_CACHE_KEY,
        verifyOptions: {
          issuer: requirements.issuer,
          audience: requirements.audience,
          requiredClaims: ["exp", "sub", "client_id", "scope", "aud", "umail_operator"],
        },
      }),
    catch: () => unauthorizedAccessToken(),
  });
  if (payload.cnf !== undefined) {
    return yield* Effect.fail(unauthorizedAccessToken());
  }
  const decoded = Schema.decodeUnknownResult(OAuthAccessTokenClaims)(payload);
  if (Result.isFailure(decoded) || !hasExactAudience(decoded.success.aud, requirements.audience)) {
    return yield* Effect.fail(unauthorizedAccessToken());
  }
  const scopes = new Set(decoded.success.scope.split(" ").filter((scope) => scope.length > 0));
  const missingScopes = requirements.scopes.filter((scope) => !scopes.has(scope));
  if (missingScopes.length > 0) {
    return yield* Effect.fail(createInsufficientScopeError(missingScopes));
  }
  return {
    subject: decoded.success.sub,
    clientId: decoded.success.client_id,
    scopes,
  } satisfies OAuthAccess;
});

export function oauthResourceChallenge(
  error: unknown,
  resource: string,
  scopes: ReadonlyArray<string>,
) {
  return createResourceServerChallenge(error, resource, { challengeScopes: scopes });
}

function hasExactAudience(audience: string | ReadonlyArray<string>, expected: string): boolean {
  if (Array.isArray(audience)) {
    return audience.length === 1 && audience[0] === expected;
  }
  return audience === expected;
}

function unauthorizedAccessToken(): APIError {
  return new APIError("UNAUTHORIZED", { message: "Invalid OAuth access token" });
}
