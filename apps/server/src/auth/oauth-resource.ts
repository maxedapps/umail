import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import {
  createInsufficientScopeError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
} from "better-auth/oauth2";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UmailBetterAuth } from "./options.ts";

const OAuthAccessTokenClaims = Schema.Struct({
  sub: Schema.String.check(Schema.isMinLength(1)),
  client_id: Schema.String.check(Schema.isMinLength(1)),
  scope: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  umail_operator: Schema.Literal(true),
});

export type OAuthAccess = {
  readonly subject: string;
  readonly clientId: string;
  readonly scopes: ReadonlySet<string>;
};

export type OAuthResourceRequirements = {
  readonly issuer: string;
  readonly audience: string;
  readonly scopes: ReadonlyArray<string>;
};

export async function verifyOAuthResourceRequest(
  auth: UmailBetterAuth,
  request: Request,
  requirements: OAuthResourceRequirements,
): Promise<OAuthAccess> {
  const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
  if (authorization === undefined || authorization.scheme !== "Bearer") {
    throw unauthorizedAccessToken();
  }
  return verifyOAuthBearerToken(auth, authorization.token, requirements);
}

export async function verifyOAuthBearerToken(
  auth: UmailBetterAuth,
  token: string,
  requirements: OAuthResourceRequirements,
): Promise<OAuthAccess> {
  let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
  try {
    payload = await verifyJwsAccessToken(token, {
      jwksFetch: () => auth.api.getJwks({}),
      jwksCacheKey: auth,
      verifyOptions: {
        issuer: requirements.issuer,
        audience: requirements.audience,
        requiredClaims: ["exp", "sub", "client_id", "scope", "aud", "umail_operator"],
      },
    });
  } catch {
    throw unauthorizedAccessToken();
  }

  if (payload.cnf !== undefined) {
    throw unauthorizedAccessToken();
  }
  const decoded = Schema.decodeUnknownResult(OAuthAccessTokenClaims)(payload);
  if (Result.isFailure(decoded) || !hasExactAudience(decoded.success.aud, requirements.audience)) {
    throw unauthorizedAccessToken();
  }
  const scopes = new Set(decoded.success.scope.split(" ").filter((scope) => scope.length > 0));
  const missingScopes = requirements.scopes.filter((scope) => !scopes.has(scope));
  if (missingScopes.length > 0) {
    throw createInsufficientScopeError(missingScopes);
  }
  return {
    subject: decoded.success.sub,
    clientId: decoded.success.client_id,
    scopes,
  };
}

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
